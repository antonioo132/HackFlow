import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicMode = process.env.HACKFLOW_MODE === 'review' || !['127.0.0.1','localhost','::1'].includes(process.env.HOST ?? '127.0.0.1');
const calledDirectly = Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
const demoMode = process.argv[2] === '--demo' || (calledDirectly && !publicMode && !process.argv[2]);
if (demoMode && publicMode) throw new Error('Деморежим доступен только на localhost.');
const publicDemo = publicMode && process.env.HACKFLOW_PUBLIC_DEMO === '1';
const memoryOnly = demoMode || publicDemo;
const demoAccounts = new Map();
const storage = process.env.HACKFLOW_DATA_DIR
  ? resolve(process.env.HACKFLOW_DATA_DIR)
  : fileURLToPath(new URL('./data/', import.meta.url));
if (!memoryOnly) mkdirSync(storage, { recursive: true });
const db = join(storage,'mvp.json');
const css = readFileSync(new URL('./style.css', import.meta.url));
const boardScript = readFileSync(new URL('./board.js', import.meta.url));
const users = {
  organizer: { name: 'Нина Соколова', label: 'Организатор' },
  captain: { name: 'Максим Волков', label: 'Участник · создаёт команду' },
  participant: { name: 'Лена Орлова', label: 'Участник · вступает в команду' },
  mentor: { name: 'Илья Серов', label: 'Ментор' },
  guest: { name: 'Анна Белова', label: 'Участник · без команды' }
};
const passwordMin = publicMode ? 12 : 4;
const organizerCode = process.env.HACKFLOW_ORGANIZER_CODE;
const reviewKey = process.env.HACKFLOW_REVIEW_KEY;
const hostedReview = publicMode && !publicDemo && (reviewKey?.length ?? 0)>=16;
const reviewEnabled = () => (publicDemo || hostedReview) && demoAccounts.size>0;
const canBootstrap = () => !publicMode && organizers().length === 0;
const sessions = new Map();
const status = ['К выполнению', 'В работе', 'На проверке', 'Выполнено'];
const eventTypes = ['Старт', 'Публикация кейса', 'Обучение', 'Вебинар', 'Консультация', 'Промежуточный дедлайн', 'Сдача проекта', 'Финальная защита', 'Результаты'];
const programmingEventTypes = ['Старт', 'Раунд', 'Разбор задач', 'Результаты'];
const formats = [['hackathon','Хакатон'],['programming','Чемпионат по спортивному программированию']];
const maxCaseFileBytes = 2*1024*1024;
const maxEventFileBytes = 8*1024*1024;
const caseFileExtensions = /\.(pdf|doc|docx|txt|md|zip|png|jpe?g|csv|xlsx|pptx|json|in|out)$/i;
function emptyHackathon() {
  const start = Date.now();
  return {
    event: { title: '', description: '', rules: '', caseText: '', criteria: '', start, deadline: start + 24*3600_000, published: false },
    poll: false, teams: [], agenda: [], resources: [], notifications: [], access: {}, activity: {}, invitations: []
  };
}
function seed() {
  return { ...emptyHackathon(), accounts: [], hackathons: {} };
}
let state;
function persist(next) {
  if (!memoryOnly) {
    writeFileSync(db + '.tmp', JSON.stringify(next));
    renameSync(db + '.tmp', db);
  }
  state = next;
}
if (memoryOnly) state=seed();
else {
  try { state = JSON.parse(readFileSync(db, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; persist(seed()); }
}

const eventContext = new AsyncLocalStorage();
const primaryHack = 'primary';
const selectedHack = () => eventContext.getStore() ?? primaryHack;
const currentEventData = () => selectedHack() === primaryHack ? state : state.hackathons[selectedHack()];
const allHackathons = data => [[primaryHack,data], ...Object.entries(data.hackathons ?? {})];
const ownerOf = data => data.owner ?? (data === state ? state.accounts.find(person=>person.role==='organizer')?.id : undefined);
const canManage = user => Boolean(user && hasRole(user,'organizer') && ownerOf(currentEventData()) === user);
function accessStatus(data,id) {
  if(data.applications?.some(application=>application.status==='pending' && application.members.includes(id))) return 'requested';
  if(data.access?.[id]) return data.access[id];
  if(data!==state || !id) return undefined;
  const legacyAdmission = account(id)?.admitted;
  if(legacyAdmission===true) return 'admitted';
  if(memberTeam(data,id)) return legacyAdmission===false?'revoked':'admitted';
}
const platformTeam = user => (state.platformTeams??[]).find(team=>team.members.includes(user));
const pendingApplications = data => (data.applications??[]).filter(item=>item.status==='pending');
const teamApplication = (data,user) => (data.applications??[]).findLast(item=>item.members.includes(user));
const participationLabels = {
  admitted:['Участие подтверждено','good'],
  requested:['Заявка на рассмотрении','pending'],
  revoked:['Допуск отозван','warn'],
  rejected:['Заявка отклонена','warn'],
  withdrawn:['Заявка отозвана','neutral'],
  open:['Регистрация открыта','neutral'],
  closed:['Регистрация закрыта','neutral']
};
function participationStatus(data,user) {
  const access=accessStatus(data,user);
  if(access==='admitted' && memberTeam(data,user)) return 'admitted';
  if(access==='requested' || access==='revoked') return access;
  const application=teamApplication(data,user);
  if(application?.status==='rejected' || application?.status==='withdrawn') return application.status;
  return data.event.deadline>Date.now()?'open':'closed';
}
function saveHackathon(next) {
  if (selectedHack() === primaryHack) persist(next);
  else persist({ ...state, hackathons:{ ...state.hackathons, [selectedHack()]:next } });
}
function scopedUrl(location) {
  if(selectedHack()===primaryHack) return location;
  const url = new URL(location,'http://localhost');
  if(!url.searchParams.has('hack')) url.searchParams.set('hack',selectedHack());
  return url.pathname+url.search+url.hash;
}
function scopeLinks(markup) {
  return markup.replace(/href="(\/(?:[?#][^"]*)?)"|action="(\/[a-z-]+)"/g, (match,href,formAction) => {
    if(href && selectedHack()!==primaryHack) return 'href="'+e(scopedUrl(href.replaceAll('&amp;','&')))+'"';
    if(href) return match;
    return ['login','sign-up','logout','demo-login','new-hackathon'].includes(formAction.slice(1))
      ? match : 'action="'+scopedUrl(formAction)+'"';
  });
}

const memberTeam = (data, user) => data.teams.find(team => team.members.includes(user));
const account = (id) => (state.accounts ?? []).find(item=>item.id===id);
const display = (id) => account(id)?.name ?? users[id]?.name ?? '';
const hasRole = (id, role) => account(id)?.role === role;
const withRole = role => (state.accounts ?? []).filter(item=>item.role===role);
const e = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dt = (value) => new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Yekaterinburg' }).format(value) + ' ЕКБ';
const inputTime = (value) => value ? new Date(value + 5 * 3600_000).toISOString().slice(0, 16) : '';
const text = (label, name, value = '', opts = 'required maxlength="120"') => '<label>'+label+'<input name="'+name+'" value="'+e(value)+'" '+opts+'></label>';
const area = (label, name, value = '', required = true) => '<label>'+label+'<textarea name="'+name+'" maxlength="3000" '+(required?'required':'')+'>'+e(value)+'</textarea></label>';
const time = (label, name, value) => text(label+' · ЕКБ', name, inputTime(value), 'type="datetime-local" required');
const link = (label, url) => url ? '<a class="button secondary" href="'+e(url)+'" target="_blank" rel="noopener noreferrer">'+label+' ↗</a>' : '';
const button = (label) => '<button>'+label+'</button>';
const hidden = (name, value) => '<input type="hidden" name="'+name+'" value="'+e(value)+'">';
const select = (label, name, options, selected) => '<label>'+label+'<select name="'+name+'">'+options.map(([id, label])=>'<option value="'+e(id)+'" '+(String(id)===String(selected)?'selected':'')+'>'+e(label)+'</option>').join('')+'</select></label>';
const action = (route, fields, label, cls = 'stack') => '<form class="'+cls+'" method="post" action="/'+route+'">'+fields+button(label)+'</form>';
const panel = (title, body, id = '') => '<section class="panel" '+(id?'id="'+id+'"':'')+'><h2>'+title+'</h2>'+body+'</section>';
const notice = (data, recipients, message, href='/') => data.notifications.push({ id: randomUUID(), recipients: [...new Set(recipients.filter(Boolean))], message, href, at: Date.now() });
const admitted = id => hasRole(id,'participant') && accessStatus(currentEventData(),id)==='admitted';
const participants = () => withRole('participant').filter(item=>admitted(item.id)).map(item=>item.id);
const eventOrganizers = () => [ownerOf(currentEventData())].filter(Boolean);
const organizers = () => withRole('organizer').map(item=>item.id);
const isParticipant = (user) => hasRole(user,'participant');
const isAdvisor = user => hasRole(user,'mentor') || hasRole(user,'expert');
const assigned = (team,user) => isAdvisor(user) && (team.mentor===user || team.expert===user);
const canView = (team,user) => team && !team.archived && (canManage(user) || (admitted(user)&&team.members.includes(user)) || assigned(team,user));
const programming = event => event.format==='programming';
const formatName = event => formats.find(([id])=>id===event.format)?.[1] ?? formats[0][1];
const casesName = event => programming(event)?'Задачи':'Кейсы';
function eventCases(data) {
  if(data.cases) return data.cases;
  return data.event.caseText?[{id:'legacy',title:programming(data.event)?'Основная задача':'Основной кейс',
    description:data.event.caseText,files:[]}]:[];
}
function caseChoice(data) {
  const cases=eventCases(data);
  if(programming(data.event) || cases.length<2) return '';
  return select('Выберите кейс','caseId',[['','Выберите из списка'],...cases.map(item=>[item.id,item.title])],'');
}
function caseHeading(data,id) {
  return eventCases(data).find(item=>item.id===id)?.title;
}
function caseFileLink(file) {
  const href=e(scopedUrl('/case-file?id='+encodeURIComponent(file.id)));
  return '<a href="'+href+'">'+e(file.name)+'</a> <small class="muted">· '+Math.max(1,Math.ceil(file.size/1024))+' КБ</small>';
}
function casesOpen(data) {
  return !programming(data.event) || Date.now()>=data.event.start;
}
function eventProgram(data,team) {
  const event=data.event;
  const choice=caseHeading(data,team?.caseId);
  let items='<p class="muted">Организатор ещё не добавил задания.</p>';
  if(!casesOpen(data)) items='<p>Условия задач и файлы откроются '+dt(event.start)+'.</p>';
  else if(eventCases(data).length) items=eventCases(data).map(item=>'<article class="case-entry"><h3>'+e(item.title)+
    '</h3><p class="preserved-lines">'+e(item.description)+'</p>'+
    (item.files?.length?'<ul>'+item.files.map(file=>'<li>'+caseFileLink(file)+'</li>').join('')+'</ul>':'')+'</article>').join('');
  const tools=programming(event)?'<div class="form-actions">'+
    (casesOpen(data)?link('Открыть систему проверки',event.judgeUrl):'')+link('Открыть таблицу результатов',event.standingsUrl)+'</div>':'';
  return panel(casesName(event)+' и правила',(choice?'<p class="badge good">Кейс команды: '+e(choice)+'</p>':'')+
    items+'<h3>Условия отбора</h3><p class="preserved-lines">'+e(event.selectionRules||event.rules||'Организатор не указал отдельные условия.')+'</p>'+
    '<h3>Правила участия</h3><p class="preserved-lines">'+e(event.rules)+'</p><h3>'+
    (programming(event)?'Правила зачёта':'Критерии оценки')+'</h3><p class="preserved-lines">'+e(event.criteria)+'</p>'+tools,'case');
}

const roleLabels = { organizer:'Организатор', mentor:'Ментор', expert:'Эксперт', participant:'Участник' };
const brand = href => '<a class="brand" href="'+href+'"><span class="brand-mark" aria-hidden="true"></span>HackFlow</a>';
const themeControl = '<div class="theme-control" data-theme-control hidden><span>Тема</span><div role="group" aria-label="Цветовая тема"><button type="button" data-theme-mode="system" title="Как в системе" aria-label="Как в системе">▣</button><button type="button" data-theme-mode="light" title="Светлая" aria-label="Светлая">☀</button><button type="button" data-theme-mode="dark" title="Тёмная" aria-label="Тёмная">☾</button></div></div>';

function layout(user, title, content, error = '', nav = '', role = '') {
  const documentStart = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+e(title)+' · HackFlow</title><link rel="stylesheet" href="/style.css"><script src="/board.js" defer></script></head>';
  const warning = error ? '<p role="alert" class="warning">'+e(error)+'</p>' : '';
  if (!user) {
    return documentStart+'<body><header>'+brand('/')+themeControl+'</header><main><h1>'+e(title)+'</h1>'+warning+content+'</main><footer>HackFlow <span>Code Invaders</span></footer></body></html>';
  }
  const name = display(user);
  const profileRole = role || roleLabels[account(user)?.role];
  const profile = '<div class="sidebar-profile"><span class="account-avatar" aria-hidden="true">'+e(Array.from(name)[0])+'</span><div><strong>'+e(name)+'</strong><small>'+e(profileRole)+'</small></div>'+action('logout','','Выйти','inline logout')+'</div>';
  const event = currentEventData().event;
  const organizer = hasRole(user,'organizer');
  const scope = nav && event.title && !organizer ? '<p class="sidebar-event">'+e(event.title)+'</p>' : '';
  const teamLink = isParticipant(user)?'<a class="hackathon-switch" href="/my-team">Моя команда на площадке</a>':'';
  return documentStart+scopeLinks('<body class="app-shell"><aside class="sidebar">'+brand('/hackathons')+'<a class="hackathon-switch" href="/hackathons">'+(organizer?'Мои хакатоны':'Все хакатоны')+'</a>'+teamLink+scope+nav+profile+themeControl+'<small class="sidebar-credit">Code Invaders</small></aside><div class="app-workspace"><header class="workspace-header"><h1>'+e(title)+'</h1></header><main>'+warning+content+'</main></div></body></html>');
}
function signIn(error, register = false, email = '', name = '', role = 'participant', showLogin = false) {
  const roles = [['participant','Участник'],['organizer','Организатор'],['mentor','Ментор · по приглашению'],['expert','Эксперт · по приглашению']];
  const available = canBootstrap() || (organizerCode?.length ?? 0) >= 16;
  const choices = select('Кем регистрируетесь','role',available?roles:roles.filter(([id])=>id!=='organizer'),role);
  const invite = '<div data-invite-field '+(canBootstrap()?'data-first-organizer':'')+'>'+text('Код приглашения','invite','','maxlength="256" autocomplete="off"')+'</div>';
  const fields = (register?choices+text('Имя','name',name,'required maxlength="120" autocomplete="name"')+invite:'') +
    text('Электронная почта','email',email,'type="email" required maxlength="254" autocomplete="email"') +
    text('Пароль','password','','type="password" required maxlength="128" autocomplete="'+(register?'new-password':'current-password')+'"');
  const organizerHint=canBootstrap()?'Первый организатор на этой локальной установке создаёт аккаунт без кода.':
    available?'Организатор регистрируется с кодом от администратора площадки.':'Чтобы открыть регистрацию организаторов, администратор должен настроить код приглашения.';
  const body = (register?'<p class="muted">'+organizerHint+' Менторы и эксперты получают коды от организатора. Пароль от '+passwordMin+' символов.</p>':'') +
    action(register?'sign-up':'login', fields, register?'Создать аккаунт':'Войти') +
    (register?'<p>Уже есть аккаунт? <a href="/?login">Войти</a></p>':'<p>Впервые здесь? <a href="/?signup">Зарегистрироваться</a></p>')+
    (reviewEnabled()?'<p><a href="/review">Демо для жюри</a></p>':'');
  if(demoMode && !register && !showLogin) {
    const descriptions={organizer:'Публикуйте хакатон, допускайте участников и следите за прогрессом.',mentor:'Помогайте назначенным командам и отвечайте на вопросы капитанов.',expert:'Изучайте сданные решения и оставляйте заключения по критериям.'};
    const cards=[...demoAccounts].map(([label,id])=>panel(label,'<p class="muted">'+(descriptions[account(id).role]??(memberTeam(currentEventData(),id)?'Работайте с задачами, общайтесь и готовьте проект к сдаче.':'Создайте команду или присоединитесь по коду приглашения.'))+'</p><small class="demo-name">'+e(display(id))+'</small>'+action('demo-login',hidden('account',id),'Открыть'))).join('');
    return layout(null,'Демо HackFlow','<p class="intro">Выберите роль. Изменения сохраняются до перезапуска демо.</p><div class="form-actions"><a class="button secondary" href="/?signup">Создать аккаунт</a><a href="/?login">Войти с почтой</a></div><div class="cards">'+cards+'</div>',error);
  }
  return layout(null,register?'Создайте аккаунт':'С возвращением','<div class="auth-layout"><aside class="auth-story"><p class="eyebrow">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</p><h2>От первой идеи<br>до финальной защиты.</h2><p>Команда, задачи и поддержка специалистов — в одном месте.</p><ul><li>Понятный следующий шаг</li><li>Общение внутри команды</li><li>Результат, который готов к защите</li></ul></aside><div class="auth panel">'+body+'</div></div>',error);
}
function reviewPage(error='') {
  const roles=[...demoAccounts].map(([label,id])=>[id,label]);
  const fields=select('Роль','account',roles)+
    (publicDemo?'':text('Код для жюри','reviewKey','','type="password" required maxlength="160" autocomplete="off"'));
  return layout(null,'Демо для жюри',panel('Выберите роль',
    '<p>Тестовые роли работают с общими демонстрационными данными.</p>'+
    action('review',fields,'Войти в демо')+(publicDemo?'':'<p><a href="/?login">Обычный вход</a></p>')),error);
}
function matchesCode(expected,provided) {
  const a=Buffer.from(expected??'');
  const b=Buffer.from(provided??'');
  return a.length>=16 && a.length===b.length && timingSafeEqual(a,b);
}
function project(project) {
  if (!project) return '<p class="muted">Проект ещё не сдан.</p>';
  return '<strong>'+e(project.name)+'</strong><p>'+e(project.description)+'</p>'+link('Открыть решение',project.link)+'<p class="muted">Сдано '+dt(project.at)+'</p>';
}
const taskDate = new Intl.DateTimeFormat('ru-RU', {
  day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Yekaterinburg'
});
function taskBoard(team,user) {
  const member=team.members.includes(user);
  const captain=team.captain===user;
  const assignees=[['','Не назначен'],...team.members.filter(admitted).map(id=>[id,display(id)])];
  const taskInfo = task => '<small class="task-meta">'+e(display(task.owner)||'Не назначен')+
    '<time title="'+e(dt(task.due))+'" datetime="'+new Date(task.due).toISOString()+'">'+e(taskDate.format(task.due))+'</time></small>';
  const canMove = task => member && (captain || task.owner===user);
  const taskControls = task => {
    const move = canMove(task)
      ? action('move',hidden('id',task.id)+select('Статус','status',status.map((name,i)=>[i,name]),task.status),'Переместить','stack task-move') : '';
    const assign = captain
      ? action('assign-task',hidden('id',task.id)+select('Ответственный','owner',assignees,task.owner??''),'Сохранить назначение') : '';
    const comments=task.comments?.length?messageList(task.comments):'';
    const comment=captain?action('task-comment',hidden('id',task.id)+area('Замечание к задаче','body'),'Добавить замечание'):'';
    return move+assign+(comments||comment?'<section class="task-comments"><h4>Замечания</h4>'+comments+comment+'</section>':'');
  };
  const filterData = task => ' data-task-status="'+task.status+'" data-task-mine="'+(task.owner===user)+'" data-task-search="'+e(task.name+' '+task.description+' '+display(task.owner))+'"';
  const columns=status.map((label,index)=>{
    const tasks=team.tasks.filter(task=>task.status===index);
    const cards=tasks.map(task=>{
      return '<article class="task" data-task-card="'+e(task.id)+'"'+filterData(task)+' '+(canMove(task)?'draggable="true" data-movable':'')+'><details class="task-details"><summary><strong>'+e(task.name)+'</strong>'+taskInfo(task)+'</summary><div class="task-content"><p>'+e(task.description)+'</p>'+taskControls(task)+'</div></details></article>';
    }).join('');
    return '<section class="lane" data-lane="'+index+'"><h3>'+label+' <span data-lane-count>'+tasks.length+'</span></h3>'+cards+'<p class="muted lane-empty" '+(cards?'hidden':'')+'>Нет задач</p></section>';
  }).join('');
  const complete=team.tasks.filter(task=>task.status===3).length;
  const add=action('task',text('Название','name')+area('Описание','description')+(captain?select('Ответственный','owner',assignees):'')+time('Срок','due',currentEventData().event.deadline),'Добавить задачу');
  const progress='<p class="muted">Выполнено '+complete+' из '+team.tasks.length+(member?' · Статус меняет капитан или ответственный.':'')+'</p>';
  const toolbar = '<div class="task-toolbar" data-task-toolbar hidden><label>Поиск задач<input type="search" data-task-query placeholder="Название, описание или имя"></label><label>Статус<select data-task-status-filter><option value="">Все статусы</option>'+status.map((label,index)=>'<option value="'+index+'">'+label+'</option>').join('')+'</select></label>'+
    (member?'<label class="task-mine"><input type="checkbox" data-task-mine-filter> Только мои</label>':'')+
    '<div class="segmented" role="group" aria-label="Вид задач"><button type="button" data-task-mode="list">Список</button><button type="button" data-task-mode="board">Доска</button></div></div>';
  const rows = team.tasks.map(task => '<button type="button" class="task-row" data-task-key="'+e(task.id)+'"'+filterData(task)+'><strong>'+e(task.name)+'</strong><span>'+status[task.status]+'</span>'+taskInfo(task)+'</button>').join('');
  const details = team.tasks.map(task => '<article class="task-detail" data-task-detail="'+e(task.id)+'" hidden><h3>'+e(task.name)+'</h3><ol class="task-stages" aria-label="Этапы задачи">'+status.map((label,index)=>'<li '+(index<task.status?'class="past"':index===task.status?'aria-current="step"':'')+'>'+label+'</li>').join('')+'</ol><p>'+e(task.description)+'</p>'+taskInfo(task)+taskControls(task)+'</article>').join('');
  const list = '<div class="task-list-view" hidden><div class="task-rows" aria-label="Список задач">'+rows+'</div><div class="task-details-pane">'+details+'<p class="muted" data-task-empty>Нет задач по выбранным условиям.</p></div></div>';
  return '<section class="panel board-panel" id="board"><h2>Доска команды</h2>'+progress+(member?'<details class="create-box"><summary>Новая задача</summary>'+add+'</details>':'')+toolbar+'<div class="board" role="region" aria-label="Статусы задач" tabindex="0">'+columns+'</div>'+list+'</section>';
}
function messageList(items) {
  return items.length ? '<ul class="messages">'+items.map(item=>'<li><strong>'+e(display(item.author))+'</strong> <small>'+dt(item.at)+'</small><p>'+e(item.body)+'</p></li>').join('')+'</ul>' : '<p class="muted">Пока пусто.</p>';
}
function meeting(meet) {
  return '<p>'+dt(meet.at)+'</p>'+(meet.link?link('Подключиться',meet.link):'<p class="muted">Ссылку организатор добавит позже.</p>');
}
function checkpoint(team,user) {
  const explain='<p class="muted">Чекпоинт — короткий звонок команды с организатором или ментором.</p>';
  if (!team.registered) return panel('Чекпоинт',explain+'<p>После регистрации команды здесь появится информация о звонке.</p>','checkpoint');
  const topic=team.checkpoint?.topic ? '<p>Тема: '+e(team.checkpoint.topic)+'</p>' : '';
  if (team.meeting) return panel('Чекпоинт','<span class="badge good">Встреча назначена</span>'+meeting(team.meeting)+topic,'checkpoint');
  if (!currentEventData().poll) return panel('Чекпоинт',explain+'<p>Организатор ещё не открыл опрос.</p>','checkpoint');
  const answer=team.checkpoint?.answer;
  const captain=team.captain===user;
  const wait=answer==='yes'?'Ожидаем время и ссылку':answer==='no'?'Команда отказалась от звонка':'Нужен чекпоинт?';
  const note=answer==='yes'?'<p>Организатор получил запрос. Время и ссылка появятся здесь и в расписании.</p>':
    answer==='no'?'<p>Встреча пока не планируется.</p>':captain?'<p>Выберите ответ за всю команду.</p>':'<p>Ответ отправляет капитан.</p>';
  const form='<form class="stack" method="post" action="/checkpoint">'+area('Тема звонка (необязательно)','topic',team.checkpoint?.topic,false)+
    '<div class="form-actions"><button name="answer" value="yes">Да, нужен звонок</button><button class="secondary" name="answer" value="no">Нет, спасибо</button></div></form>';
  const controls=captain?(answer?'<details><summary>Изменить ответ</summary>'+form+'</details>':form):'';
  return panel('Чекпоинт',explain+'<div class="checkpoint-state"><strong>'+wait+'</strong>'+note+topic+'</div>'+controls,'checkpoint');
}
function checkpointUpdate(team,user,full) {
  if(full) return checkpoint(team,user);
  if(!team.meeting) return '';
  const href=eventPage('checkpoint');
  return panel('Чекпоинт назначен',meeting(team.meeting)+'<p><a href="'+href+'">Открыть чекпоинт</a></p>');
}
function workspace(team,user,section = 'all') {
  const event=currentEventData().event;
  const own = team.members.includes(user);
  const canSubmit = !programming(event) && team.captain === user && team.registered && !team.submission && Date.now() < event.deadline;
  const registration = team.captain===user && !team.registered ? action('register','','Зарегистрировать команду') : '';
  const captain = team.captain === user;
  const roster = '<ul class="roster">'+team.members.map(id=>{
    const remove = captain && id!==user && !team.submission && !team.sourceTeam ? action('kick',hidden('member',id),'Исключить','inline roster-action') : '';
    return '<li><span>'+e(display(id))+(id===team.captain?' · капитан':'')+'</span>'+remove+'</li>';
  }).join('')+'</ul>';
  let leave = '';
  if (own && !team.submission && !team.sourceTeam) {
    if (captain && team.members.length>1) {
      leave=action('leave',select('Передать роль капитана','successor',team.members.filter(id=>id!==user).map(id=>[id,display(id)])),'Передать роль и выйти');
    } else {
      leave=action('leave','',captain?'Закрыть команду и выйти':'Выйти из команды','inline roster-action');
    }
  }
  const count = team.members.length+(currentEventData().event.teamSize?' из '+currentEventData().event.teamSize:'');
  const invite = own && !team.submission && !team.sourceTeam ? '<p>Код приглашения <code>'+e(team.code)+'</code></p>' : '';
  const overview = '<details class="panel roster-panel" id="team" '+(!team.registered?'open':'')+'><summary><strong>'+e(team.name)+'</strong> · '+count+'</summary>'+roster+(team.mentor?'<p>Ментор · '+e(display(team.mentor))+'</p>':'')+(team.expert?'<p>Эксперт · '+e(display(team.expert))+'</p>':'')+invite+registration+leave+'</details>';
  const send = canSubmit ? action('submit',text('Название','name')+area('Описание','description')+text('Ссылка на решение','link','','type="url" required maxlength="1000"'),'Сдать проект') : '';
  const chat = own ? panel('Командный чат',messageList(team.messages)+action('chat',area('Сообщение','body'),'Отправить'),'chat') : '';
  const canWrite=assigned(team,user)||(captain&&Boolean(team.mentor||team.expert));
  const noAdvisor=!(team.mentor||team.expert);
  const guidance=noAdvisor
    ? '<p class="muted">Организатор ещё не назначил ментора или эксперта. После назначения капитан сможет начать диалог.</p>'
    : own&&!captain?'<p class="muted">Переписку видит вся команда. Сообщения от команды отправляет капитан.</p>':'';
  const history=team.feedback.length?messageList(team.feedback):
    noAdvisor?'':'<p class="muted">Сообщений пока нет.</p>';
  const feedback=panel('Диалог с ментором и экспертом',guidance+history+
    (canWrite?action('feedback',hidden('team',team.id)+area('Сообщение','body'),'Отправить сообщение'):''),'feedback');
  const reviews=panel('Экспертное заключение', '<p class="muted">Критерии: '+e(currentEventData().event.criteria)+'</p>'+(team.reviews?.length?messageList(team.reviews):'<p class="muted">После сдачи проекта назначенный эксперт оставит здесь отзыв.</p>')+(team.expert===user&&team.submission?action('review',hidden('team',team.id)+area('Итоговый отзыв по критериям','body'),'Опубликовать заключение'):''),'review');
  const submission = programming(event)
    ? panel('Сдача решений',casesOpen(currentEventData())
      ? '<p>Отправляйте решения и проверяйте вердикты во внешней системе.</p>'+(link('Открыть систему проверки',event.judgeUrl)||'<p class="muted">Ссылка на систему проверки ещё не опубликована.</p>')
      : '<p>Ссылка будет доступна после старта '+dt(event.start)+'.</p>','send')
    : panel('Сдача проекта',project(team.submission)+(Date.now()>=event.deadline&&!team.submission?'<p class="warning">Срок сдачи истёк.</p>':'')+send,'send')+reviews;
  const sections = { team: overview, checkpoint: checkpoint(team,user), board: taskBoard(team,user), chat, feedback, send: submission };
  if (section === 'team') return overview+'<div class="team-work">'+sections.board+chat+'</div>'+feedback;
  return section === 'all' ? Object.values(sections).join('') : sections[section];
}
function schedule(team) {
  const event=currentEventData().event;
  const contest=programming(event);
  const automatic = [
    { name: contest?'Старт чемпионата':'Старт хакатона', type: 'Старт', at:event.start },
    { name: contest?'Открытие задач':'Публикация кейсов', type: contest?'Раунд':'Публикация кейса', at:event.start },
    { name: contest?'Окончание зачёта':'Итоговая сдача', type: contest?'Раунд':'Сдача проекта', at:event.deadline }
  ];
  const items = [...automatic,...currentEventData().agenda,...(team?.meeting?[{...team.meeting,name:'Чекпоинт команды',type:'Консультация'}]:[])].sort((a,b)=>a.at-b.at);
  return panel('Расписание','<ul class="messages">'+items.map(item=>'<li><strong>'+e(item.name)+'</strong><p>'+e(item.type)+' · '+dt(item.at)+'</p>'+(item.speaker?'<p>'+e(item.speaker)+'</p>':'')+(item.description?'<p>'+e(item.description)+'</p>':'')+link('Подключиться или открыть запись',item.link)+'</li>').join('')+'</ul>','schedule');
}
function resources() {
  return panel('Образовательные материалы',currentEventData().resources.length?'<ul class="messages">'+currentEventData().resources.map(item=>'<li><strong>'+e(item.name)+'</strong><p>'+e(item.description)+'</p>'+link('Открыть материал',item.link)+'</li>').join('')+'</ul>':'<p class="muted">Материалы ещё не опубликованы.</p>','resources');
}
const eventPage = (section = 'home') => '/?view=event&section='+section;
const notificationPage = section => ['board','chat','feedback'].includes(section) ? eventPage('team')+'#'+section : ['case','schedule','resources'].includes(section) ? eventPage('program')+'#'+section : eventPage(section);
function alerts(user,team) {
  const generated = [];
  const at = Date.now();
  if (team?.registered && !team.submission && at<currentEventData().event.deadline && currentEventData().event.deadline-at<=2*3600_000) {
    generated.push({message:programming(currentEventData().event)?'До конца чемпионата меньше двух часов':'До сдачи меньше двух часов',href:'/#send',at});
  }
  for (const item of currentEventData().agenda) if (item.type==='Вебинар' && item.at<=at && at-item.at<3600_000) generated.push({ message: 'Начался вебинар «'+item.name+'»', href: '/#schedule', at: item.at });
  const items = [...generated,...currentEventData().notifications.filter(item=>item.recipients.includes(user))].sort((a,b)=>b.at-a.at);
  const href = item => {
    const oldAnchor = /^\/(?:\?view=event)?#([a-z]+)$/.exec(item.href);
    return oldAnchor ? notificationPage(oldAnchor[1]) : item.href;
  };
  return panel('Уведомления',items.length?'<ul class="messages">'+items.slice(0,30).map(item=>'<li><a href="'+e(href(item))+'">'+e(item.message)+'</a> <small>'+dt(item.at)+'</small></li>').join('')+'</ul>':'<p class="muted">Новых событий пока нет.</p>','notifications');
}
function organizerNavigation(page,user) {
  const pending=pendingApplications(currentEventData()).length;
  const sections=[
    ['', 'Команды'],['event','Настройки мероприятия'],['cases',casesName(currentEventData().event)],['access','Заявки команд'+(pending?' · '+pending:'')],
    ['schedule','Расписание'],['materials','Материалы'],['staff','Менторы и эксперты'],['analytics','Аналитика']
  ];
  const activePage=page==='content'?'schedule':page??'';
  const options=allHackathons(state).filter(([,data])=>ownerOf(data)===user).map(([id,data])=>[id,data.event.title||'Новый хакатон']);
  const picker='<form class="hackathon-picker" action="/" method="get">'+
    select('Текущий хакатон','hack',options,selectedHack())+hidden('edit',activePage)+button('Перейти')+'</form>';
  return picker+'<nav aria-label="Разделы организатора" class="tabs">'+sections.map(([id,label])=>
    '<a href="'+(id?'/?edit='+id:'/')+'" '+(activePage===id?'aria-current="page"':'')+'>'+label+'</a>').join('')+'</nav>';
}

function organizerCases(data,query) {
  const label=casesName(data.event);
  const fields=(item={})=>text('Название','title',item.title)+area('Условие','description',item.description);
  const list=eventCases(data).map(item=>{
    const caseId=hidden('caseId',item.id);
    const files=(item.files??[]).map(file=>'<li>'+caseFileLink(file)+' '+
      action('remove-case-file',caseId+hidden('fileId',file.id),'Удалить','inline roster-action')+'</li>').join('');
    const upload='<form method="post" action="/upload-case-file" enctype="multipart/form-data" class="stack">'+caseId+
      '<label>Файл<input name="file" type="file" required></label>'+button('Прикрепить файл')+'</form>';
    return '<details class="panel" '+(query.get('case')===item.id?'open':'')+'><summary><strong>'+e(item.title)+'</strong><span>'+(item.files?.length??0)+' файлов</span></summary>'+
      action('save-case',caseId+fields(item),'Сохранить условие')+'<h3>Файлы</h3>'+
      (files?'<ul class="messages">'+files+'</ul>':'<p class="muted">Файлов пока нет.</p>')+upload+'</details>';
  }).join('');
  return panel(label,'<p>Добавьте условия и файлы. Команды получают материалы после допуска'+
    (programming(data.event)?' и старта чемпионата.':' В хакатоне с несколькими кейсами капитан выбирает один при подаче заявки.')+
    '</p><p class="muted">До 2 МБ на файл и 8 МБ на мероприятие. Поддерживаются документы, изображения, ZIP и тестовые данные.</p>'+
    '<details class="create-box" '+(!list?'open':'')+'><summary>'+(programming(data.event)?'Добавить задачу':'Добавить кейс')+
    '</summary>'+action('save-case',fields(),'Добавить')+'</details>')+'<div class="case-list">'+list+'</div>';
}

function organizer(query) {
  const event = currentEventData().event;
  const training = text('Название материала','name')+area('Описание','description','',false)+text('Ссылка','link','','type="url" required maxlength="1000"');
  const scheduleTypes=programming(event)?programmingEventTypes:eventTypes;
  const meetingFields = (item={}) => select('Тип','type',[...new Set([...scheduleTypes,...(item.type?[item.type]:[])])].map(label=>[label,label]),item.type)+text('Название','name',item.name)+time('Дата и время','at',item.at)+area('Описание','description',item.description,false)+text('Спикер','speaker',item.speaker,'maxlength="120"')+text('Ссылка на эфир или запись','link',item.link,'type="url" maxlength="1000"');
  const page=query.get('edit');
  if(page==='cases') return organizerCases(currentEventData(),query);
  const editEvent=page==='event' && (query.has('form') || !event.published);
  const fields=(title,body)=>'<fieldset class="setup-group"><legend>'+title+'</legend><div class="stack">'+body+'</div></fieldset>';
  const basics=fields('Что увидят в каталоге',select('Формат мероприятия','format',formats,event.format??'hackathon')+
    text('Название мероприятия','title',event.title)+area('Короткое описание','description',event.description));
  const rules=fields('Отбор и участие',area('Условия отбора · видны до заявки','selectionRules',event.selectionRules??event.rules)+
    area('Правила участия','rules',event.rules)+area('Критерии оценки или правила зачёта','criteria',event.criteria)+
    (event.caseText&&!currentEventData().cases?area('Текст основного кейса','caseText',event.caseText,false):'')+
    '<p class="muted">Добавляйте отдельные задания и файлы на вкладке «'+casesName(event)+'».</p>');
  const contest='<fieldset class="setup-group" data-programming-settings><legend>Для спортивного программирования</legend><div class="stack">'+
    text('Ссылка на систему проверки решений','judgeUrl',event.judgeUrl,'type="url" maxlength="1000"')+
    text('Ссылка на таблицу результатов','standingsUrl',event.standingsUrl,'type="url" maxlength="1000"')+
    '<p class="muted">Условия задач откроются командам в момент старта. Решения проверяются во внешней системе.</p></div></fieldset>';
  const dates=fields('Сроки и размер команды','<div class="duo">'+time('Начало','start',event.start)+time('Дедлайн сдачи','deadline',event.deadline)+
    text('Минимум участников на команду','minTeamSize',event.minTeamSize??1,'type="number" min="1" max="9999" required')+
    text('Максимум участников на команду','teamSize',event.teamSize??'','type="number" min="1" max="9999" placeholder="Без ограничения"')+
    '</div><p class="muted">Минимум 1 разрешает индивидуальное участие.</p>');
  const manage=editEvent
    ? panel(event.published?'Редактирование мероприятия':'Создание мероприятия','<p class="muted">Заполните карточку и сроки. Задания можно добавлять в черновик и после публикации.</p><form method="post" action="/event" class="stack">'+basics+dates+rules+contest+'<div class="form-actions"><button name="published" value="true">'+(event.published?'Сохранить изменения':'Опубликовать мероприятие')+'</button>'+'<button class="secondary" name="published" value="false">'+(event.published?'Снять с публикации':'Сохранить черновик')+'</button>'+'</div></form>','manage')
    : panel(e(event.title),'<span class="badge good">Опубликован</span><p>'+e(event.description)+'</p><p>Начало · '+dt(event.start)+'<br>Сдача до · '+dt(event.deadline)+'</p><div class="form-actions"><a class="button" href="/?edit=event&amp;form=1">Редактировать хакатон</a><a class="button secondary" href="/?edit=access">Настроить допуск</a></div>','manage');
  const agendaList=currentEventData().agenda.slice().sort((a,b)=>a.at-b.at).map(item=>
    '<details class="panel admin-row"><summary><strong>'+e(item.name)+'</strong><span>'+dt(item.at)+'</span></summary>'+
    action('agenda',hidden('id',item.id)+meetingFields(item),'Сохранить изменения')+action('remove-agenda',hidden('id',item.id),'Отменить событие','inline roster-action')+'</details>').join('');
  const calendar=panel('Расписание','<p>Участники видят события в «Программе». Старт и дедлайн берутся из карточки хакатона.</p><details class="create-box" '+(query.get('add')==='1'?'open':'')+'><summary>Добавить событие</summary>'+action('agenda',meetingFields(),'Опубликовать событие')+'</details>','calendar')+
    (agendaList||'<p class="panel muted">Дополнительных событий пока нет. Добавьте вебинар, консультацию или защиту.</p>');
  const resourceList=currentEventData().resources.map(item=>'<li><strong>'+e(item.name)+'</strong><p>'+e(item.description)+'</p>'+link('Открыть материал',item.link)+'</li>').join('');
  const materials=panel('Учебные материалы','<p>Опубликуйте ссылку на запись, документ или презентацию. Допущенные участники найдут её в «Программе».</p><details class="create-box" '+(query.get('add')==='1'?'open':'')+'><summary>Добавить материал</summary>'+action('resource',training,'Опубликовать материал')+'</details>','materials')+
    (resourceList?panel('Опубликовано','<ul class="messages">'+resourceList+'</ul>'):'<p class="panel muted">Материалов пока нет.</p>');
  const reason = team => {
    if (team.checkpoint?.answer==='yes' && !team.meeting) return 'Запросили чекпоинт';
    if (team.meeting && !team.meeting.link && team.meeting.at>Date.now()) return 'Добавьте ссылку на чекпоинт';
    if (team.submission || programming(event)) return '';
    const left=event.deadline-Date.now();
    if (left<=0) return 'Дедлайн прошёл, проект не сдан';
    return left<=2*3600_000 ? 'До дедлайна меньше двух часов, проект не сдан' : '';
  };
  const formed=currentEventData().teams.filter(team=>!team.archived);
  const registered=formed.filter(team=>team.registered);
  const attention=registered.filter(reason);
  const selected = query.get('tab')==='attention' ? attention : formed;
  const poll = !currentEventData().poll ? '<p>Спросите зарегистрированные команды, нужен ли им короткий звонок. Тем, кто ответит «Да», можно назначить время и отправить ссылку.</p>'+action('poll','','Открыть опрос') : '<p>Опрос открыт. Запросы без ссылки попадают в фильтр «Требуют внимания».</p><p>Запросили: '+registered.filter(t=>t.checkpoint?.answer==='yes').length+' · Отказались: '+registered.filter(t=>t.checkpoint?.answer==='no').length+' · Ждём ответа: '+registered.filter(t=>!t.checkpoint).length+'</p>';
  const activePage=page==='content'?'schedule':page??'';
  if(activePage==='staff') {
    const invites=(currentEventData().invitations??[]).slice().reverse().map(inv=>'<li><div><strong>'+e(inv.email)+'</strong> · '+(inv.role==='mentor'?'Ментор':'Эксперт')+'</div><p>'+(inv.used?'Приглашение принято':inv.revoked?'Приглашение отозвано':inv.expires<Date.now()?'Срок истёк':'Код: <code>'+e(inv.code)+'</code> · до '+dt(inv.expires))+'</p>'+(!inv.used&&!inv.revoked&&inv.expires>Date.now()?action('revoke-invite',hidden('id',inv.id),'Отозвать','inline roster-action'):'')+'</li>').join('');
    return panel('Пригласите специалистов','<p class="muted">Ментор помогает командам в процессе. Эксперт изучает сданное решение и оставляет итоговый отзыв. Передайте код лично: письмо автоматически не отправляется.</p>'+action('invite-staff',select('Роль','role',[['mentor','Ментор'],['expert','Эксперт']])+text('Почта приглашённого','email','','type="email" required maxlength="254"'),'Создать приглашение'))+panel('Приглашения',invites?'<ul class="messages">'+invites+'</ul>':'<p class="muted">Пока нет приглашений. Код действует 7 дней и используется один раз.</p>')+panel('Специалисты',withRole('mentor').concat(withRole('expert')).map(person=>'<p><strong>'+e(person.name)+'</strong> · '+(person.role==='mentor'?'Ментор':'Эксперт')+'<br><small>'+e(person.email)+'</small></p>').join('')+'<p><a href="/">Назначить специалистов командам →</a></p>');
  }
  if(query.get('edit')==='access') {
    const data=currentEventData();
    const applications=(data.applications??[]).slice().reverse().map(item=>{
      const fields=hidden('application',item.id);
      const key={pending:'requested',approved:'admitted'}[item.status] ?? item.status;
      const [label,tone]=participationLabels[key];
      const controls=item.status==='pending'
        ? '<div class="form-actions">'+action('approve-team',fields,'Допустить команду','inline')+action('reject-team',fields,'Отклонить','inline roster-action')+'</div>' : '';
      const choice=caseHeading(data,item.caseId);
      return '<li><strong>'+e(item.name)+'</strong> <span class="badge '+tone+'">'+label+'</span><p>Капитан: '+e(display(item.captain))+'</p><p>'+item.members.map(id=>e(display(id))).join(', ')+'</p>'+
        (choice?'<p>Кейс: '+e(choice)+'</p>':'')+controls+'</li>';
    }).join('');
    const roster=withRole('participant').filter(item=>accessStatus(data,item.id) &&
      !['pending','approved'].includes(teamApplication(data,item.id)?.status)).map(item=>{
      const approved=admitted(item.id);
      const revoked=accessStatus(currentEventData(),item.id)==='revoked';
      const control=!approved?action('admit',hidden('account',item.id),'Допустить','inline'):
        action('revoke',hidden('account',item.id),'Отозвать допуск','inline roster-action');
      return '<li class="access-row"><div><strong>'+e(item.name)+'</strong><p class="muted">'+e(item.email)+'</p></div><span class="badge '+(approved?'good':'warn')+'">'+(approved?'Допущен':revoked?'Допуск отозван':'Ожидает допуска')+'</span>'+control+'</li>';
    }).join('');
    return panel('Заявки команд','<p>Капитан отправляет одну заявку со всем составом. После допуска для команды откроются кейс, доска и сдача проекта.</p>'+
      (applications?'<ul class="messages">'+applications+'</ul>':'<p class="muted">Заявок от команд пока нет.</p>'))+
      (roster?panel('Допуск по прежней регистрации','<ul class="messages">'+roster+'</ul>'):'');
  }
  if(query.get('edit')==='event') return manage;
  if(activePage==='schedule') return calendar;
  if(activePage==='materials') return materials;
  if(activePage==='analytics') {
    const eligible=participants();
    const start=Date.now()-24*3600_000;
    const active=withRole('participant').filter(person=>admitted(person.id) && (currentEventData().activity?.[person.id]??(selectedHack()===primaryHack?person.lastActivity:0)??0)>=start).length;
    const completed=formed.reduce((count,team)=>count+team.tasks.filter(task=>task.status===3).length,0);
    const submitted=registered.filter(team=>team.submission).length;
    const counts=[
      ['Допущено участников',eligible.length],['Активны за 24 часа',active],
      ['Сформировано команд',formed.length],['Завершено задач на доске',completed]
    ];
    const stages=[
      ['Сформировали команду',formed.length],['Зарегистрировали состав',registered.length],
      ['Начали работу в HackFlow',registered.filter(team=>team.tasks.length||team.messages.length||team.submission).length]
    ];
    if(!programming(event)) {
      counts.push(['Отправлено решений',submitted]);
      stages.push(['Сдали решение',submitted]);
    }
    const rows=stages.map(([label,count])=>'<li><strong>'+label+'</strong> · '+count+' из '+formed.length+'<br><progress max="'+Math.max(formed.length,1)+'" value="'+count+'" aria-label="'+label+'"></progress></li>').join('');
    return '<div class="metrics">'+counts.map(([label,count])=>'<div><strong>'+count+'</strong>'+label+'</div>').join('')+'</div>'+
      panel('Прогресс команд','<ul class="messages">'+rows+'</ul><p class="muted">Активность учитывает вход и действия в мероприятии за последние сутки.</p>'+
        (programming(event)?link('Открыть таблицу результатов',event.standingsUrl):''));
  }
  const launch = !event.published ? '<a class="button" href="/?edit=event">Создать хакатон</a>' : pendingApplications(currentEventData()).length ? '<a class="button" href="/?edit=access">Проверить заявки команд</a>' : '<a class="button secondary" href="/?edit=schedule">Открыть расписание</a>';
  const attentionOnly=query.get('tab')==='attention';
  const filters='<nav class="team-filters" aria-label="Фильтр команд"><a href="/" '+(!attentionOnly?'aria-current="page"':'')+'>Все команды · '+formed.length+'</a><a href="/?tab=attention" '+(attentionOnly?'aria-current="page"':'')+'>Требуют внимания · '+attention.length+'</a></nav>';
  const middleMetric=programming(event)?'<strong>'+pendingApplications(currentEventData()).length+'</strong>Заявок на рассмотрении':
    '<strong>'+registered.filter(t=>t.submission).length+'</strong>Сдали проект';
  return '<section class="organizer-overview panel"><div><span class="badge '+(event.published?'good':'warn')+'">'+(event.published?'Опубликован':'Черновик')+'</span><h2>'+e(event.title)+'</h2><p class="muted">Сдача до '+dt(event.deadline)+'</p></div>'+launch+'</section><div class="metrics"><div><strong>'+registered.length+'</strong>Зарегистрировано</div><div>'+middleMetric+'</div><div><strong>'+attention.length+'</strong>Требуют внимания</div></div>'+
    filters+'<div class="stack">'+(selected.length ? selected.map(team=>{
      const r = reason(team);
      const t = team.checkpoint;
      const focused=query.get('meeting')===team.id;
      const meet = currentEventData().poll && (t?.answer==='yes'||team.meeting)
        ? '<p>'+e(t?.topic||'Тема не указана')+'</p>'+(team.meeting?meeting(team.meeting):'')+action('meeting',hidden('team',team.id)+time('Время звонка','at',team.meeting?.at)+text('Ссылка на звонок (можно добавить позже)','link',team.meeting?.link,'type="url" maxlength="1000"'),team.meeting?'Обновить чекпоинт':'Назначить чекпоинт')
        : '';
      const reply = team.meeting?'Встреча назначена':t?.answer==='no'?'Отказались':t?.answer==='yes'?'Запросили':'Ждём ответа';
      return '<details class="panel" id="team-'+e(team.id)+'" '+(focused?'open':'')+'><summary><strong>'+e(team.name)+'</strong><span class="'+(r?'warn':team.submission?'good':'muted')+'">'+e(r||(team.submission?'Сдано':team.registered?'В работе':'Состав не зарегистрирован'))+'</span></summary><div class="detail">'+(focused && query.get('saved')==='1'?'<p class="badge good" role="status">Чекпоинт сохранён. Команда получила уведомление.</p>':'')+'<p>Капитан · '+e(display(team.captain))+'</p><div class="admin-roster"><strong>Состав</strong>'+team.members.map(id=>'<span class="admin-member">'+e(display(id))+(account(id)&&!admitted(id)?' (без допуска)':'')+
        ''+'</span>').join('')+'</div>'+(programming(event)?link('Таблица результатов',event.standingsUrl):project(team.submission))+'<p><a href="/?team='+e(team.id)+'">Открыть доску и отзывы</a></p>'+action('mentor',hidden('team',team.id)+select('Ментор','mentor',[['','Без ментора'],...withRole('mentor').map(item=>[item.id,item.name])],team.mentor??'')+select('Эксперт','expert',[['','Без эксперта'],...withRole('expert').map(item=>[item.id,item.name])],team.expert??''),'Сохранить назначения')+(currentEventData().poll?'<p>Чекпоинт · '+reply+'</p>':'')+meet+'</div></details>';
    }).join(''):'<p class="panel">'+(attentionOnly?'Сейчас ни одной команде не требуется внимание.':'Здесь появятся команды после регистрации состава капитаном.')+'</p>')+'</div>'+panel('Опрос по чекпоинтам',poll);
}
function hackathonCatalog(user,error='',mine=false) {
  const organizer = hasRole(user,'organizer');
  const advisor = isAdvisor(user);
  const visible = allHackathons(state).filter(([id,data]) => {
    if (organizer) return ownerOf(data)===user;
    if (advisor) return data.teams.some(team=>!team.archived && assigned(team,user));
    return data.event.published && (!mine || !['open','closed'].includes(participationStatus(data,user)));
  });
  const cards = visible.map(([id,data]) => {
    const event = data.event;
    const key = participationStatus(data,user);
    const [label,tone] = organizer
      ? (event.published?['Опубликован','good']:['Черновик','neutral'])
      : advisor?['Есть назначенные команды','neutral']:participationLabels[key];
    const route = '/?hack='+encodeURIComponent(id);
    const cta=organizer?'Управлять':advisor?'Открыть команды':key==='admitted'?'Открыть хакатон':
      key==='open'?'Зарегистрироваться на хакатон':'Подробнее';
    const open = '<a class="button secondary" href="'+route+'">'+cta+'</a>';
    return panel(e(event.title||'Новый хакатон'),'<span class="badge '+tone+'">'+label+'</span>'+
      '<p><small class="muted">'+formatName(event)+'</small></p><p>'+e(event.description||'Добавьте описание и сроки перед публикацией.')+'</p>'+
      (event.title?'<p class="muted">Сдача до '+dt(event.deadline)+'</p>':'')+'<div class="form-actions">'+open+'</div>');
  });
  const create = organizer?action('new-hackathon','','Создать хакатон'):'';
  const filters = organizer || advisor ? '' : '<nav class="team-filters" aria-label="Каталог хакатонов"><a href="/hackathons" '+(!mine?'aria-current="page"':'')+'>Все мероприятия</a><a href="/hackathons?mine=1" '+(mine?'aria-current="page"':'')+'>Моё участие</a></nav>';
  const empty = organizer?'Создайте первый хакатон и опубликуйте его.':advisor?'Организаторы ещё не назначили вам команды.':mine?'Здесь появятся мероприятия, на которые вы подали заявку.':'Опубликованные хакатоны появятся здесь.';
  return layout(user,organizer?'Мои хакатоны':advisor?'Назначенные хакатоны':'Хакатоны',create+filters+
    (cards.length?'<div class="cards hackathon-cards">'+cards.join('')+'</div>':'<p class="panel muted">'+empty+'</p>'),error);
}

function myTeamPage(user,error='') {
  const team=platformTeam(user);
  const intro='<p class="intro">Создайте команду или вступите по коду. На командные хакатоны заявку отправляет капитан.</p>';
  if(!team) return layout(user,'Моя команда на площадке',intro+'<div class="duo">'+
    panel('Создать команду',action('platform-create-team',text('Название команды','name'),'Создать'))+
    panel('Вступить в команду',action('platform-join-team',text('Код приглашения','code','','required maxlength="10"'),'Вступить по коду'))+'</div>'+
    '<p><a href="/hackathons">Посмотреть хакатоны, включая индивидуальные</a></p>',error);
  const captain=team.captain===user;
  const roster='<ul class="roster">'+team.members.map(id=>'<li><span>'+e(display(id))+
    (id===team.captain?' · капитан':'')+'</span>'+
    (captain && id!==user?action('platform-kick',hidden('member',id),'Исключить','inline roster-action'):'')+'</li>').join('')+'</ul>';
  const successors=captain?team.members.filter(id=>id!==user):[];
  const leave=successors.length
    ? action('platform-leave',select('Передать роль капитана','successor',successors.map(id=>[id,display(id)])),'Передать роль и выйти')
    : action('platform-leave','',captain?'Закрыть команду':'Выйти из команды','inline roster-action');
  return layout(user,'Моя команда на площадке',intro+panel(e(team.name),
    (captain?'<p>Код приглашения <code>'+e(team.code)+'</code></p>':'<p class="muted">Кодом приглашения делится капитан.</p>')+
    roster+'<p class="muted">Изменения состава применяются к новым заявкам. В уже поданных заявках сохраняется отправленный состав.</p>'+
    '<p><a class="button" href="/hackathons">Выбрать хакатон</a></p>'+leave),error,'',captain?'Капитан':'Участник');
}

function applicationPage(user,data,error) {
  const event=data.event;
  const application=teamApplication(data,user);
  const team=platformTeam(user);
  const legacy=accessStatus(data,user);
  if(!event.published) return layout(user,'Ваш кабинет готов',panel('Хакатон пока недоступен','<p>Выберите опубликованное мероприятие в каталоге.</p><a class="button secondary" href="/hackathons">Все хакатоны</a>'),error);
  const active=application?.status==='pending';
  let next;
  if(active) {
    next='<p>Организатор рассматривает заявку команды «'+e(application.name)+'».</p>'+
      (application.captain===user?action('withdraw-team',hidden('application',application.id),'Отозвать заявку','inline roster-action'):'');
  } else if(legacy==='requested' || legacy==='revoked') {
    next='<p>'+(legacy==='requested'?'Ожидаем решения организатора по вашей прежней заявке.':'Допуск отозван. Свяжитесь с организатором.')+'</p>';
  } else if(Date.now()>=event.deadline) {
    next='<p>Приём заявок завершён.</p>';
  } else if(!team) {
    next=(event.minTeamSize??1)===1
      ? '<p>Можно участвовать одному или с командой.</p>'+action('apply-team',hidden('mode','solo')+caseChoice(data),'Зарегистрироваться одному')+'<p><a class="button secondary" href="/my-team">Собрать команду</a></p>'
      : '<p>Для этого хакатона нужна команда. Создайте её или вступите по коду. Заявку за состав отправляет капитан.</p><a class="button" href="/my-team">Создать команду или вступить</a>';
  } else if(data.teams.some(item=>!item.archived && item.registered &&
    (item.sourceTeam===team.id || item.members.includes(team.captain)))) {
    next='<p>Команда уже зарегистрирована на этот хакатон. Доступ есть у участников из поданного состава.</p>';
  } else if(team.captain!==user) {
    next='<p>Заявку за команду «'+e(team.name)+'» отправляет капитан '+e(display(team.captain))+'.</p>';
  } else {
    const sizeError=teamSizeError(event,team.members.length);
    next='<p>Команда «'+e(team.name)+'»</p><ul>'+team.members.map(id=>'<li>'+e(display(id))+'</li>').join('')+'</ul>'+
      (sizeError?'<p class="warning">'+sizeError+'</p>':
        action('apply-team',caseChoice(data),'Зарегистрировать команду'));
  }
  const [label,tone]=participationLabels[participationStatus(data,user)];
  const status='<span class="badge '+tone+'">'+label+'</span>';
  const caseTitles=programming(event)?'':eventCases(data).map(item=>'<li>'+e(item.title)+'</li>').join('');
  const conditions=panel('Условия отбора','<p class="muted">'+formatName(event)+' · '+dt(event.start)+' — '+dt(event.deadline)+'</p>'+
    '<p>'+e(event.description)+'</p><p class="preserved-lines">'+e(event.selectionRules||event.rules||'Организатор не указал отдельные условия.')+'</p>'+
    (caseTitles?'<h3>Кейсы на выбор</h3><ul>'+caseTitles+'</ul>':'')+
    (programming(event)?'<h3>Правила зачёта</h3><p class="preserved-lines">'+e(event.criteria)+'</p>':''));
  const choice=caseHeading(data,application?.caseId);
  return layout(user,event.title,conditions+panel('Заявка на участие',
    '<p class="muted">Размер состава: от '+(event.minTeamSize??1)+(event.teamSize?' до '+event.teamSize:'')+
    '</p>'+status+(choice?'<p>Кейс: '+e(choice)+'</p>':'')+next),error);
}

function screen(user, query, error) {
  if (!user) {
    if(publicDemo) return reviewPage(error);
    if(query.has('login')) return signIn(error,false,'','','participant',true);
    if(demoMode && !query.has('signup')) return signIn(error);
    if (error || query.has('login') || query.has('signup') || query.has('team')) return signIn(error,query.has('signup'));
    return signIn(error);
  }
  const teamId=query.get('team');
  if (teamId && (hasRole(user,'organizer')||isAdvisor(user))) {
    const team=currentEventData().teams.find(t=>t.id===teamId);
    if (canView(team,user)) return layout(user,team.name,'<p><a href="/">← К списку команд</a></p>'+(hasRole(user,'expert')?workspace(team,user,'send')+workspace(team,user,'feedback')+'<details class="panel"><summary>Посмотреть доску команды</summary>'+taskBoard(team,user)+'</details>':workspace(team,user)),error);
  }
  if(hasRole(user,'organizer')) {
    if(!canManage(user)) return hackathonCatalog(user,error);
    const edit=query.get('edit');
    const titles={staff:'Менторы и эксперты',event:'Настройки мероприятия',cases:casesName(currentEventData().event),access:'Заявки команд',schedule:'Расписание',content:'Расписание',materials:'Материалы',analytics:'Аналитика'};
    return layout(user,Object.hasOwn(titles,edit)?titles[edit]:'Команды хакатона',organizer(query),error,organizerNavigation(edit,user));
  }
  if(isAdvisor(user)) {
    const teams=currentEventData().teams.filter(t=>!t.archived&&assigned(t,user));
    const messages=currentEventData().notifications.filter(item=>item.recipients.includes(user)).slice(-10).reverse();
    const updates=messages.length?panel('Сообщения от капитанов','<ul class="messages">'+messages.map(item=>'<li><a href="'+e(item.href)+'">'+e(item.message)+'</a> <small>'+dt(item.at)+'</small></li>').join('')+'</ul>'):'';
    return layout(user,hasRole(user,'expert')?'Команды эксперта':'Команды ментора',updates+(teams.map(t=>panel(e(t.name),'<span class="badge '+(t.submission?'good':'warn')+'">'+(t.submission?'Решение сдано':'Команда работает')+'</span><p class="muted">'+t.members.length+' участников · '+t.tasks.filter(task=>task.status===3).length+' из '+t.tasks.length+' задач завершено</p><a class="button" href="/?team='+e(t.id)+'">'+(hasRole(user,'expert')?'Посмотреть решение':'Помочь команде')+'</a>')).join('')||'<p>Организатор ещё не назначил вам команду.</p>'),error);
  }
  const event=currentEventData().event;
  const team=memberTeam(currentEventData(),user);
  if(!event.published || !team || !admitted(user)) return applicationPage(user,currentEventData(),error);
  const isCaptain=team?.captain===user;
  const open=Date.now()<event.deadline;
  const upcoming=[...currentEventData().agenda,...(team?.meeting?[{...team.meeting,name:'Чекпоинт команды'}]:[])].filter(item=>item.at>Date.now()).sort((a,b)=>a.at-b.at)[0];
  const next = !team ? ['Создайте команду или вступите по коду','team','Выбрать команду']
    : !team.registered ? [isCaptain?'Зарегистрируйте команду':'Капитан регистрирует команду','team','Открыть состав']
    : currentEventData().poll && isCaptain && !team.checkpoint ? ['Ответьте на приглашение к чекпоинту','checkpoint','Ответить']
    : team.submission ? ['Проект сдан','send','Посмотреть сдачу']
    : programming(event)?['Задачи чемпионата','program','Открыть программу']
    : isCaptain && open && event.deadline-Date.now()<=2*3600_000 ? ['Пора сдавать проект','send','Перейти к сдаче']
    : ['Продолжите работу над проектом','team','Открыть команду'];
  const tabs=[['home','Обзор'],['program','Программа'],['team','Команда']];
  if(team) tabs.push(['checkpoint','Чекпоинт']);
  if(team?.registered) tabs.push(['send',programming(event)?'Сдача решений':'Сдача']);
  const aliases={case:'program',schedule:'program',resources:'program',board:'team',chat:'team',feedback:'team'};
  const requested=query.get('section');
  const section=Object.hasOwn(aliases,requested)?aliases[requested]:requested;
  const active=tabs.some(([id])=>id===section)||section==='notifications'?section:'home';
  const navigation='<nav aria-label="Разделы хакатона" class="tabs">'+tabs.map(([id,label])=>'<a href="'+eventPage(id)+'" '+(active===id?'aria-current="page"':'')+'>'+label+'</a>').join('')+'<a class="notifications-link" href="'+eventPage('notifications')+'" '+(active==='notifications'?'aria-current="page"':'')+'>Уведомления</a></nav>';
  const overview='<section class="panel hero"><div class="hero-copy"><p class="kicker">Следующий шаг</p><h2>'+next[0]+'</h2><a class="button" href="'+eventPage(next[1])+'">'+next[2]+'</a></div><div class="hero-aside"><div><small>Срок сдачи</small><strong>'+dt(event.deadline)+'</strong></div>'+(upcoming?'<div><small>Ближайшее событие</small><a href="'+eventPage('program')+'#schedule">'+e(upcoming.name)+'</a><small>'+dt(upcoming.at)+'</small></div>':'')+'</div></section>';
  const join=!open?panel('Регистрация закрыта','<p>Срок вступления в команду истёк.</p>','team'):panel('Нет команды?', '<p>Создайте свою команду или введите код, который прислал капитан.</p><div class="duo">'+action('create-team',text('Название команды','name'),'Создать команду')+action('join',text('Код приглашения','code','','required maxlength="10"'),'Вступить по коду')+'</div>','team');
  const pages={
    home:()=>'<p class="intro">Здравствуйте, '+e(display(user).split(' ')[0])+'. '+(team?'Продолжим работу с командой «'+e(team.name)+'».':'Вы допущены к хакатону. Начните со знакомства с кейсом и выбора команды.')+'</p>'+overview+'<div class="dashboard-grid">'+panel('Моя команда',team?'<span class="badge good">'+(team.submission?'Проект сдан':team.registered?'Состав зарегистрирован':'Собираем состав')+'</span><h3>'+e(team.name)+'</h3><p class="muted">'+team.members.length+' участников · '+(isCaptain?'Вы капитан':'Капитан — '+e(display(team.captain)))+'</p><a href="'+eventPage('team')+'">Перейти к команде →</a>':'<p class="muted">Создайте команду и пригласите участников или введите код капитана.</p><a href="'+eventPage('team')+'">Найти своё место в команде →</a>')+panel('Мои задачи',team?'<strong class="dashboard-number">'+team.tasks.filter(t=>t.owner===user&&t.status!==3).length+'</strong><p class="muted">Незавершённых задач назначено вам</p><a href="'+eventPage('team')+'#board">Открыть доску →</a>':'<p class="muted">После вступления в команду здесь появятся назначенные вам задачи.</p>')+panel('Кейс и материалы','<p class="muted">Изучите задачу, критерии оценки и правила перед началом работы.</p><a href="'+eventPage('program')+'">Открыть программу →</a>')+'</div>',
    case:()=>eventProgram(currentEventData(),team),
    schedule:()=>schedule(team),
    resources,
    notifications:()=>alerts(user,team)
  };
  pages.program=()=>'<div class="program-links"><a href="#case">'+casesName(event)+' и правила</a><a href="#schedule">Расписание</a><a href="#resources">Материалы</a></div>'+pages.case()+pages.schedule()+pages.resources();
  const fullCheckpoint=active==='checkpoint';
  const liveUrl=scopedUrl('/checkpoint-update'+(fullCheckpoint?'?full=1':''));
  const live=team?.registered
    ? '<div class="checkpoint-live" data-checkpoint-update="'+e(liveUrl)+'" aria-live="polite">'+checkpointUpdate(team,user,fullCheckpoint)+'</div>' : '';
  const body=team?.registered && fullCheckpoint ? '' : pages[active]?.() ?? (team?workspace(team,user,active):join);
  return layout(user,event.title,live+body,error,navigation,isCaptain?'Капитан':'Участник');

}


class RequestError extends Error {
  constructor(message, code = 400) { super(message); this.code=code; }
}
const fail = (message,code) => { throw new RequestError(message,code); };
function check(condition,message='Действие недоступно.',code=403) { if(!condition) fail(message,code); }
async function readForm(req,multipart=false) {
  const buffers=[];
  let size=0;
  for await (const chunk of req) {
    const buffer=Buffer.from(chunk);
    size+=buffer.length;
    if(size>(multipart?maxCaseFileBytes+32768:45000)) fail(multipart?'Файл слишком большой. Максимум 2 МБ.':'Форма слишком большая.',413);
    buffers.push(buffer);
  }
  const body=Buffer.concat(buffers);
  if(!multipart) return new URLSearchParams(body.toString('utf8'));
  const type=req.headers['content-type']??'';
  check(/^multipart\/form-data\s*;/i.test(type),'Загрузите файл через форму.',400);
  try { return await new Response(body,{headers:{'Content-Type':type}}).formData(); }
  catch { fail('Не удалось прочитать файл.',400); }
}
function field(form,name,max=120,required=true) {
  const raw=form.get(name);
  check(raw===null || typeof raw==='string','Проверьте формат поля.',400);
  const value=raw?.trim()??'';
  check(value.length<=max && (!required||value.length>0),'Проверьте заполнение полей.',400);
  return value;
}
function date(form,name) {
  const value=field(form,name);
  const at=Date.parse(value+'+05:00');
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && Number.isFinite(at) && inputTime(at)===value,'Укажите корректную дату и время.',400);
  return at;
}
function external(form,required=true,name='link') {
  const value=field(form,name,1000,required);
  if(!value) return '';
  const url=URL.parse(value);
  check(url && ['http:','https:'].includes(url.protocol) && !url.username && !url.password,'Укажите действующую ссылку HTTP или HTTPS.',400);
  return url.href;
}
function createAccount(data,role,name,email,password) {
  email=email.trim().toLowerCase();
  name=name.trim();
  check(name.length>0&&name.length<=120,'Введите имя длиной до 120 символов.',400);
  check(email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Укажите корректный адрес почты.',400);
  check(password.length>=passwordMin && password.length<=128,'Введите пароль длиной от '+passwordMin+' до 128 символов.',400);
  data.accounts ??= [];
  check(!data.accounts.some(item=>item.email===email),'Не удалось создать аккаунт. Проверьте адрес или попробуйте войти.',409);
  const salt=randomBytes(16).toString('hex');
  const hash=scryptSync(password,salt,64).toString('hex');
  const record={id:randomUUID(),role,name,email,salt,hash,admitted:false};
  data.accounts.push(record);
  return record;
}
function authenticate(email,password) {
  const record=(state.accounts??[]).find(item=>item.email===email);
  const hash=scryptSync(password,record?.salt??'unused-account-placeholder',64);
  return record && timingSafeEqual(hash,Buffer.from(record.hash,'hex')) ? record : null;
}
function removeMember(team, member) {
  team.members=team.members.filter(id=>id!==member);
  team.code=randomBytes(5).toString('hex');
  for(const task of team.tasks) if(task.owner===member) task.owner=null;
}
const platformRoutes = new Set(['platform-create-team','platform-join-team','platform-leave','platform-kick']);
function changePlatformTeam(user,path,form) {
  const next=structuredClone(state);
  const teams=next.platformTeams??=[];
  const team=teams.find(item=>item.members.includes(user));
  if(path==='platform-create-team' || path==='platform-join-team') {
    check(!team,'Вы уже состоите в команде на площадке.',409);
    if(path==='platform-create-team') {
      teams.push({id:randomUUID(),name:field(form,'name'),captain:user,members:[user],code:randomBytes(5).toString('hex')});
    } else {
      const target=teams.find(item=>item.code===field(form,'code',10).toLowerCase());
      check(target,'Команда с таким кодом не найдена.',404);
      target.members.push(user);
    }
  } else {
    check(team,'У вас пока нет команды.',404);
    const kick=path==='platform-kick';
    const member=kick?form.get('member'):user;
    if(kick) check(team.captain===user && member!==user && team.members.includes(member),'Исключить участника может капитан.');
    if(member===team.captain && team.members.length>1) {
      const successor=form.get('successor');
      check(successor!==user && team.members.includes(successor),'Выберите нового капитана.',400);
      team.captain=successor;
    }
    team.members=team.members.filter(id=>id!==member);
    team.code=randomBytes(5).toString('hex');
    if(!team.members.length) next.platformTeams=teams.filter(item=>item.id!==team.id);
  }
  persist(next);
}
function teamSizeError(event,size) {
  const min=event.minTeamSize??1;
  if(size<min) return 'В команде должно быть не меньше '+min+' участников.';
  if(event.teamSize && size>event.teamSize) return 'Состав превышает лимит этого хакатона.';
  return '';
}
function applyAsTeam(data,user,solo,caseId='') {
  check(data.event.published && Date.now()<data.event.deadline,'Приём заявок закрыт.',409);
  let team=platformTeam(user);
  if(solo) {
    check(!team,'Если вы уже в команде, заявку подаёт её капитан.',409);
    team={id:'solo:'+user,name:display(user),captain:user,members:[user]};
  }
  check(team?.captain===user,'Зарегистрировать команду может капитан.');
  const sizeError=teamSizeError(data.event,team.members.length);
  check(!sizeError,sizeError,409);
  check(!pendingApplications(data).some(item=>item.sourceTeam===team.id || item.members.some(id=>team.members.includes(id))),
    'У команды или участника уже есть заявка на этот хакатон.',409);
  check(!data.teams.some(item=>!item.archived && (item.sourceTeam===team.id || item.members.some(id=>team.members.includes(id)))),
    'Команда или участник уже зарегистрированы на этот хакатон.',409);
  check(team.members.every(id=>!['requested','revoked'].includes(accessStatus(currentEventData(),id))),
    'У участника есть прежняя заявка или отозван допуск. Обратитесь к организатору.',409);
  const cases=eventCases(data);
  let selectedCase;
  if(!programming(data.event) && cases.length) {
    selectedCase=cases.length===1 && !caseId?cases[0]:cases.find(item=>item.id===caseId);
    check(selectedCase,'Выберите кейс для заявки.',400);
  }
  data.applications??=[];
  data.applications.push({id:randomUUID(),sourceTeam:team.id,name:team.name,captain:user,members:[...team.members],caseId:selectedCase?.id,status:'pending',at:Date.now()});
}

async function parseCaseUpload(form) {
  const file=form.get('file');
  check(file instanceof File && file.size>0,'Выберите файл.',400);
  check(file.size<=maxCaseFileBytes,'Файл слишком большой. Максимум 2 МБ.',413);
  const name=file.name.replace(/[\u0000-\u001f\u007f\/\\]/g,'_').slice(0,160);
  check(caseFileExtensions.test(name),'Этот формат файла не поддерживается.',400);
  return {id:randomUUID(),name,size:file.size,content:Buffer.from(await file.arrayBuffer()).toString('base64')};
}

function changeCase(data,path,form,upload) {
  const id=field(form,'caseId',120,false);
  const cases=data.cases??=eventCases(data);
  let item=cases.find(entry=>entry.id===id);
  if(path==='save-case' && !id) {
    check(cases.length<30,'Достигнут лимит в 30 заданий.',409);
    item={id:randomUUID(),files:[]};
    cases.push(item);
  }
  check(item,'Кейс или задача не найдены.',404);
  if(path==='save-case') {
    item.title=field(form,'title');
    item.description=field(form,'description',3000);
  }
  if(path==='upload-case-file') {
    const total=cases.reduce((sum,entry)=>sum+(entry.files??[]).reduce((subtotal,file)=>subtotal+file.size,0),0);
    check(total+upload.size<=maxEventFileBytes,'Достигнут лимит файлов мероприятия: 8 МБ.',409);
    item.files??=[];
    check(item.files.length<20,'К одному заданию можно прикрепить до 20 файлов.',409);
    item.files.push(upload);
  }
  if(path==='remove-case-file') {
    const fileId=field(form,'fileId');
    check(item.files?.some(file=>file.id===fileId),'Файл не найден.',404);
    item.files=item.files.filter(file=>file.id!==fileId);
  }
  return '/?edit=cases&case='+item.id;
}
const caseActions=new Set(['save-case','upload-case-file','remove-case-file']);
function organizerAction(data,path,form,upload) {
  if(caseActions.has(path)) return changeCase(data,path,form,upload);
  const team=data.teams.find(item=>item.id===form.get('team') && !item.archived);
  switch(path) {
    case 'approve-team':
    case 'reject-team': {
      const item=pendingApplications(data).find(application=>application.id===form.get('application'));
      check(item,'Заявка уже обработана или не найдена.',409);
      if(path==='reject-team') {
        item.status='rejected';
        return '/?edit=access';
      }
      check(data.event.published && Date.now()<data.event.deadline,'Допуск закрыт: хакатон не опубликован или срок сдачи прошёл.',409);
      const sizeError=teamSizeError(data.event,item.members.length);
      check(!sizeError,sizeError,409);
      check(!data.teams.some(team=>!team.archived && item.members.some(id=>team.members.includes(id))),
        'Один из участников уже состоит в команде этого хакатона.',409);
      item.status='approved';
      data.access??={};
      for(const id of item.members) data.access[id]='admitted';
      data.teams.push({id:randomUUID(),sourceTeam:item.sourceTeam,name:item.name,captain:item.captain,members:[...item.members],caseId:item.caseId,
        registered:true,tasks:[],messages:[],feedback:[]});
      notice(data,item.members,'Ваша команда допущена к хакатону','/#team');
      return '/?edit=access';
    }
    case 'invite-staff': {
      const role=field(form,'role');
      const email=field(form,'email',254).toLowerCase();
      check(['mentor','expert'].includes(role),'Выберите роль.',400);
      check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Укажите корректную почту.',400);
      check(!state.accounts.some(item=>item.email===email),'Этот аккаунт уже существует.',409);
      data.invitations??=[];
      data.invitations.push({id:randomUUID(),code:randomBytes(18).toString('hex'),email,role,expires:Date.now()+7*86400000});
      return '/?edit=staff';
    }
    case 'revoke-invite': {
      const invitation=(data.invitations??[]).find(item=>item.id===form.get('id'));
      check(invitation&&!invitation.used,'Приглашение недоступно.',409);
      invitation.revoked=true;
      return '/?edit=staff';
    }
    case 'admit':
    case 'revoke': {
      const participant=account(form.get('account'));
      check(participant?.role==='participant','Аккаунт участника не найден.',404);
      check(!['pending','approved'].includes(teamApplication(data,participant.id)?.status),'По этому составу решение принимается через заявку команды.',409);
      check(accessStatus(currentEventData(),participant.id),'Участник ещё не подал заявку.',404);
      data.access??={};
      data.access[participant.id]=path==='admit'?'admitted':'revoked';
      return '/?edit=access';
    }
    case 'event': {
      const format=field(form,'format',30,false)||data.event.format||'hackathon';
      check(formats.some(([id])=>id===format),'Выберите формат мероприятия.',400);
      check(format===(data.event.format??'hackathon') ||
        (!data.teams.some(item=>!item.archived) && !pendingApplications(data).length),
        'Сменить формат можно до формирования команд и подачи заявок.',409);
      const start=date(form,'start'), deadline=date(form,'deadline');
      check(deadline>start,'Дедлайн должен быть позже старта.',400);
      const rawLimit=field(form,'teamSize',4,false);
      const teamSize=rawLimit===''?null:Number(rawLimit);
      const rawMin=field(form,'minTeamSize',4,false)||String(data.event.minTeamSize??1);
      const minTeamSize=Number(rawMin);
      check(/^[0-9]+$/.test(rawMin)&&minTeamSize>=1&&minTeamSize<=9999,'Укажите минимальный размер команды от 1 до 9999.',400);
      check(teamSize===null || (/^[0-9]+$/.test(rawLimit)&&teamSize>=1&&teamSize<=9999),'Введите целое число мест от 1 до 9999.',400);
      check(teamSize===null || minTeamSize<=teamSize,'Минимальный размер команды не может превышать максимальный.',400);
      check(teamSize===null || !data.teams.some(team=>!team.archived && team.members.length>teamSize),'В одной из команд уже больше участников. Укажите лимит не меньше текущего состава.',409);
      data.owner ??= ownerOf(currentEventData());
      data.event={format,minTeamSize,teamSize,title:field(form,'title'),description:field(form,'description',3000),
        selectionRules:form.has('selectionRules')?field(form,'selectionRules',3000):data.event.selectionRules,
        rules:field(form,'rules',3000),caseText:form.has('caseText')?field(form,'caseText',3000,false):data.event.caseText,
        criteria:field(form,'criteria',3000),start,deadline,published:form.get('published')==='true',
        judgeUrl:format==='programming'?external(form,false,'judgeUrl'):'',
        standingsUrl:format==='programming'?external(form,false,'standingsUrl'):''};
      if(start!==currentEventData().event.start || deadline!==currentEventData().event.deadline) notice(data,participants(),'Изменились сроки хакатона','/#schedule');
      return form.get('published')==='true'?'/?edit=event':'/?edit=event#manage';
    }
    case 'agenda': {
      const type=field(form,'type');
      const allowedTypes=programming(data.event)?programmingEventTypes:eventTypes;
      check(allowedTypes.includes(type) || data.agenda.some(item=>item.id===form.get('id') && item.type===type),'Выберите тип события.',400);
      const id=form.get('id');
      const item={id:id||randomUUID(),type,name:field(form,'name'),at:date(form,'at'),description:field(form,'description',3000,false),speaker:field(form,'speaker',120,false),link:external(form,false)};
      if(id) {
        const index=data.agenda.findIndex(row=>row.id===id);
        check(index!==-1,'Событие не найдено.',404);
        data.agenda[index]=item;
      } else data.agenda.push(item);
      notice(data,participants(),(id?'Изменилось событие «':'Новое событие «')+item.name+'»','/#schedule');
      return '/?edit=schedule';
    }
    case 'remove-agenda': {
      const index=data.agenda.findIndex(item=>item.id===form.get('id'));
      check(index!==-1,'Событие не найдено.',404);
      const [item]=data.agenda.splice(index,1);
      notice(data,participants(),'Событие отменено: '+item.name,'/#schedule');
      return '/?edit=schedule';
    }
    case 'resource': {
      const item={name:field(form,'name'),description:field(form,'description',3000,false),link:external(form)};
      data.resources.push(item);
      notice(data,participants(),'Опубликован материал «'+item.name+'»','/#resources');
      return '/?edit=materials';
    }
    case 'poll': {
      check(!data.poll,'Опрос уже открыт.',409);
      data.poll=true;
      notice(data,data.teams.filter(team=>team.registered).map(team=>team.captain),'Ответьте, нужен ли чекпоинт','/#checkpoint');
      return '/';
    }
    case 'meeting': {
      check(data.poll && team?.registered && team.checkpoint?.answer==='yes','Ссылка доступна после запроса команды.',409);
      const at=date(form,'at');
      check(at>Date.now(),'Выберите время в будущем.',400);
      const previous=team.meeting;
      const meetingLink=external(form,false);
      const dest='/?meeting='+team.id;
      if(previous?.at===at && (previous.link||'')===meetingLink) return dest+'#team-'+team.id;
      team.meeting={at,link:meetingLink};
      notice(data,team.members,previous?'Обновился чекпоинт команды':'Организатор назначил чекпоинт','/#checkpoint');
      return dest+'&saved=1#team-'+team.id;
    }
    case 'mentor': {
      check(team,'Команда не найдена.',404);
      check(form.get('mentor')==='' || hasRole(form.get('mentor'),'mentor'),'Выберите ментора.',400);
      const expert=form.get('expert');
      check(expert===null || expert==='' || hasRole(expert,'expert'),'Выберите эксперта.',400);
      team.mentor=form.get('mentor')||null;
      if(expert!==null) team.expert=expert||null;
      return '/';
    }
    default: fail('Действие не найдено.',404);
  }
}
function participantAction(data,user,path,form) {
  const team=memberTeam(data,user);
  check(admitted(user),'Дождитесь допуска от организатора.');
  check(data.event.published,'Хакатон пока не опубликован.',409);
  if(path==='create-team') {
    check(!team,'Вы уже в команде.',409);
    check(Date.now()<data.event.deadline,'Регистрация закрыта.',409);
    const name=field(form,'name');
    check(!data.teams.some(t=>!t.archived&&t.name.toLowerCase()===name.toLowerCase()),'Команда с таким названием уже существует.',409);
    data.teams.push({ id:randomUUID(),name,captain:user,members:[user],code:randomBytes(5).toString('hex'),registered:false,tasks:[],messages:[],feedback:[] });
    return eventPage('team');
  }
  if(path==='join') {
    check(!team,'Вы уже в команде.',409);
    check(Date.now()<data.event.deadline,'Вступление закрыто.',409);
    const target=data.teams.find(item=>!item.archived&&item.code===field(form,'code',10).toLowerCase());
    check(target,'Код не найден. Проверьте приглашение.',404);
    check(!target.submission,'Команда уже сдала проект.',409);
    check(!data.event.teamSize || target.members.length<data.event.teamSize,'В команде больше нет свободных мест.',409);
    target.members.push(user);
    notice(data,target.members,display(user)+' вступил(а) в команду «'+target.name+'»','/?view=event#team');
    return eventPage('team');
  }
  check(team,'Сначала создайте команду или вступите в неё.');
  if(path==='leave' || path==='kick') {
    check(!team.sourceTeam,'Состав зафиксирован в заявке на этот хакатон.',409);
    check(!team.submission,'Состав зафиксирован после сдачи проекта.',409);
    const leaving = path==='leave';
    const member = leaving ? user : form.get('member');
    if (!leaving) check(team.captain===user && member!==user && team.members.includes(member),'Исключить участника может капитан.');
    if (leaving && team.captain===user) {
      if (team.members.length===1) {
        team.archived=true;
        team.registered=false;
      } else {
        const successor=form.get('successor');
        check(successor!==user && team.members.includes(successor),'Выберите нового капитана из команды.',400);
        team.captain=successor;
        notice(data,[successor],'Вы стали капитаном команды «'+team.name+'»','/#team');
      }
    }
    removeMember(team,member);
    if (!leaving) notice(data,[member],'Вас исключили из команды «'+team.name+'»','/#team');
    return eventPage('team');
  }
  if(path==='register') {
    check(team.captain===user);
    check(!team.registered && Date.now()<data.event.deadline,'Регистрация уже завершена или закрыта.',409);
    const sizeError=teamSizeError(data.event,team.members.length);
    check(!sizeError,sizeError,409);
    team.registered=true;
    notice(data,[...team.members,...eventOrganizers()],'Команда «'+team.name+'» зарегистрировалась','/?view=event#team');
    return eventPage('team');
  }
  if (['checkpoint','submit'].includes(path)) check(team.registered,'Сначала капитан должен зарегистрировать команду.',409);
  switch(path) {
    case 'checkpoint': {
      check(team.captain===user);
      check(data.poll && !team.meeting,'Изменить ответ сейчас нельзя.',409);
      const answer=field(form,'answer');
      check(['yes','no'].includes(answer),'Выберите ответ.',400);
      team.checkpoint={answer,topic:answer==='yes'?field(form,'topic',3000,false):''};
      return eventPage('checkpoint');
    }
    case 'task': {
      const owner=team.captain===user?field(form,'owner',120,false)||null:user;
      check(owner===null || (team.members.includes(owner)&&admitted(owner)),'Выберите допущенного участника команды.',400);
      const task={id:randomUUID(),name:field(form,'name'),description:field(form,'description',3000),owner,due:date(form,'due'),status:0};
      team.tasks.push(task);
      if(owner) notice(data,[owner],'Вам назначена задача «'+task.name+'»','/#board');
      return eventPage('team')+'#board';
    }
    case 'assign-task': {
      check(team.captain===user,'Ответственных назначает капитан.');
      const task=team.tasks.find(item=>item.id===form.get('id'));
      check(task,'Задача не найдена.',404);
      const owner=field(form,'owner',120,false)||null;
      check(owner===null || (team.members.includes(owner)&&admitted(owner)),'Выберите допущенного участника команды.',400);
      if(owner!==task.owner) {
        task.owner=owner;
        if(owner) notice(data,[owner],'Вам назначена задача «'+task.name+'»','/#board');
      }
      return eventPage('team')+'#board';
    }
    case 'move': {
      const task=team.tasks.find(item=>item.id===form.get('id'));
      const position=form.get('status');
      check(task&&['0','1','2','3'].includes(position),'Проверьте задачу и статус.',400);
      check(task.owner===user || team.captain===user,'Статус меняет капитан или ответственный за задачу.');
      const next=Number(position);
      const taskPage=eventPage('team')+'&task='+task.id+'#board';
      if(next!==task.status) {
        task.status=next;
        const recipient=team.captain===user?task.owner:team.captain;
        if(recipient && recipient!==user) {
          notice(data,[recipient],'«'+task.name+'» → '+status[next]+' · '+display(user),taskPage);
        }
      }
      return taskPage;
    }
    case 'task-comment': {
      check(team.captain===user,'Оставить замечание может капитан.');
      const task=team.tasks.find(item=>item.id===form.get('id'));
      check(task,'Задача не найдена.',404);
      const body=field(form,'body',3000);
      task.comments??=[];
      task.comments.push({author:user,body,at:Date.now()});
      const taskPage=eventPage('team')+'&task='+task.id+'#board';
      if(task.owner && task.owner!==user) notice(data,[task.owner],'Замечание к задаче «'+task.name+'»',taskPage);
      return taskPage;
    }
    case 'feedback': {
      check(team.captain===user && form.get('team')===team.id && (team.mentor||team.expert),'Написать в этот диалог может капитан.');
      team.feedback.push({body:field(form,'body',3000),author:user,at:Date.now()});
      const href='/?team='+team.id+'#feedback';
      notice(data,[team.mentor,team.expert],'Капитан команды «'+team.name+'» написал сообщение',href);
      return eventPage('team')+'#feedback';
    }
    case 'chat': {
      team.messages.push({body:field(form,'body',3000),author:user,at:Date.now()});
      notice(data,team.members.filter(id=>id!==user),'Новое сообщение в командном чате','/?view=event#chat');
      return eventPage('team')+'#chat';
    }
    case 'submit': {
      check(!programming(data.event),'Решения чемпионата отправляются через систему проверки.',409);
      check(team.captain===user,'Итоговое решение отправляет капитан.');
      const at=Date.now();
      check(at<data.event.deadline,'Срок сдачи истёк.',409);
      check(!team.submission,'Проект уже сдан.',409);
      team.submission={name:field(form,'name'),description:field(form,'description',3000),link:external(form),at};
      notice(data,team.members,'Проект принят','/?view=event#send');
      notice(data,eventOrganizers(),'Команда «'+team.name+'» сдала проект','/?team='+team.id+'#send');
      return eventPage('send');
    }
    default: fail('Действие не найдено.',404);
  }
}
function mentorAction(data,user,path,form) {
  check(['feedback','review'].includes(path));
  const team=data.teams.find(item=>item.id===form.get('team'));
  check(team && !team.archived && assigned(team,user));
  if(path==='review') {
    check(team.expert===user && team.submission,'Заключение доступно назначенному эксперту после сдачи проекта.');
    team.reviews??=[];
    team.reviews.push({body:field(form,'body',3000),author:user,at:Date.now()});
    notice(data,team.members,'Эксперт опубликовал заключение по команде «'+team.name+'»','/?view=event&section=send#review');
    notice(data,eventOrganizers(),'Эксперт опубликовал заключение по команде «'+team.name+'»','/?team='+team.id+'#review');
    return '/?team='+team.id+'#review';
  }
  team.feedback.push({body:field(form,'body',3000),author:user,at:Date.now()});
  notice(data,team.members,(hasRole(user,'expert')?'Эксперт':'Ментор')+' оставил комментарий','/#feedback');
  return '/?team='+team.id+'#feedback';
}
const rates=new Map();
function limitLogin(req) {
  const ip = req.socket?.remoteAddress ?? 'local';
  const now=Date.now();
  for(const [key,entry] of rates) if(entry.until<=now) rates.delete(key);
  const entry=rates.get(ip)??{count:0,until:now+60_000};
  check(entry.count<25,'Слишком много попыток. Повторите через минуту.',429);
  entry.count++;
  rates.set(ip,entry);
}
export function handle(req,res) {
  const url=URL.parse(req.url,'http://localhost');
  if(!url) return res.writeHead(400).end();
  const requested = url.searchParams.get('hack') ?? primaryHack;
  if(requested!==primaryHack && !Object.hasOwn(state.hackathons??{},requested)) {
    return res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}).end('Хакатон не найден.');
  }
  return eventContext.run(requested,()=>handleRequest(req,res,url));
}

async function handleRequest(req,res,url) {
  const token=(req.headers.cookie??'').match(demoMode?/(?:^|;\s*)hackflow_demo=([\w-]+)/:/(?:^|;\s*)hackflow=([\w-]+)/)?.[1];
  for(const [key,session] of sessions) if(session.until<=Date.now()) sessions.delete(key);
  const user=sessions.get(token)?.user;
  const cookieName=demoMode?'hackflow_demo':'hackflow';
  const cookieFlags='; Path=/; HttpOnly; SameSite=Strict'+(publicMode?'; Secure':'');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  const page=(code=200,error='')=>{
    if(error && hasRole(user,'organizer') && req.method==='POST') {
      const route=url.pathname.slice(1);
      if(route==='event') {
        url.searchParams.set('edit','event');
        url.searchParams.set('form','1');
      }
      if(['invite-staff','revoke-invite'].includes(route)) url.searchParams.set('edit','staff');
      if(['admit','revoke','approve-team','reject-team'].includes(route)) url.searchParams.set('edit','access');
      if(caseActions.has(route)) url.searchParams.set('edit','cases');
      if(['agenda','remove-agenda','resource'].includes(route)) {
        url.searchParams.set('edit',route==='resource'?'materials':'schedule');
        url.searchParams.set('add','1');
      }
    }
    if(error && isParticipant(user) && req.method==='POST') {
      const sections={ 'create-team':'team', join:'team', register:'team', leave:'team', kick:'team', 'assign-task':'board', 'task-comment':'board', feedback:'team', task:'board', move:'board', chat:'chat', submit:'send', checkpoint:'checkpoint' };
      const section=sections[url.pathname.slice(1)];
      if(section) {
        url.searchParams.set('view','event');
        url.searchParams.set('section',section);
      }
    }
    return res.writeHead(code,{'Content-Type':'text/html; charset=utf-8'}).end(screen(user,url.searchParams,error));
  };
  const redirect=location=>res.writeHead(303,{Location:location}).end();
  if(req.method==='GET' && url.pathname==='/board.js') return res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'}).end(boardScript);
  if(req.method==='GET' && url.pathname==='/style.css') return res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'}).end(css);
  if(req.method==='GET' && url.pathname==='/case-file') {
    const data=currentEventData();
    const member=admitted(user) && memberTeam(data,user);
    const permitted=canManage(user) || (data.event.published &&
      ((member && casesOpen(data)) || data.teams.some(team=>!team.archived && assigned(team,user))));
    if(!permitted) return page(403,'Файлы доступны допущенным участникам и назначенным специалистам.');
    const file=eventCases(data).flatMap(item=>item.files??[]).find(item=>item.id===url.searchParams.get('id'));
    if(!file) return page(404,'Файл не найден.');
    const filename=encodeURIComponent(file.name.toWellFormed()).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16));
    return res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.size,
      'Content-Disposition':"attachment; filename*=UTF-8''"+filename}).end(Buffer.from(file.content,'base64'));
  }
  if(req.method==='GET' && url.pathname==='/checkpoint-update') {
    const data=currentEventData();
    const team=memberTeam(data,user);
    if(!data.event.published || !admitted(user) || !team?.registered || !team.meeting) return res.writeHead(204).end();
    const body=checkpointUpdate(team,user,url.searchParams.get('full')==='1');
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(scopeLinks(body));
  }
  if(url.pathname==='/review') {
    if(!reviewEnabled()) return page(404,'Демо для жюри недоступно.');
    if(req.method==='GET') return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(reviewPage());
  }
  if((demoMode || reviewEnabled()) && req.method==='GET' && url.pathname==='/demo-guide') {
    if(!(admitted(user)||hasRole(user,'organizer')||isAdvisor(user))) return redirect('/?login');
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(layout(user,'Подготовка защиты',panel('Проверка перед сдачей','<ol><li>Пройдите сценарий продукта с чистого аккаунта.</li><li>Проверьте ссылки и доступ к репозиторию.</li><li>Покажите, как результат появляется у организатора.</li></ol><p><a href="/">Вернуться в HackFlow</a></p>')));
  }
  if((demoMode || reviewEnabled()) && req.method==='GET' && url.pathname==='/demo-project') {
    const team = currentEventData().teams.find(item => item.submission?.link === '/demo-project');
    if(!canView(team,user)) return page(403,'Доступ к этому проекту закрыт.');
    const body = panel('Задача проекта','<p>Участники студенческих мероприятий часто узнают об изменениях из разных чатов. «Пульс» собирает расписание и обновления в одной ленте.</p>')+
      panel('Что показывает команда','<ul><li>Карточку ближайшего события с временем и ссылкой.</li><li>Изменение расписания с отметкой о переносе.</li><li>Историю обновлений для тех, кто пропустил сообщение.</li></ul>')+
      '<p class="muted">Пример материалов к сдаче в демо HackFlow.</p>';
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(layout(user,'Пульс · материалы проекта',body));
  }
  if(req.method==='GET' && url.pathname==='/health') return res.writeHead(200,{'Content-Type':'text/plain'}).end('ok');
  if(req.method==='GET' && url.pathname==='/hackathons') {
    if(!user) return redirect('/?login');
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(hackathonCatalog(user,'',url.searchParams.get('mine')==='1'));
  }
  if(req.method==='GET' && url.pathname==='/my-team') {
    if(!user) return redirect('/?login');
    if(!isParticipant(user)) return page(403,'Этот раздел доступен участникам.');
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(myTeamPage(user));
  }
  if(url.pathname!=='/' && req.method!=='POST') return page(404,'Страница не найдена.');
  if(req.method==='GET') {
    if(url.searchParams.has('hack') && hasRole(user,'organizer') && !canManage(user)) return page(403,'Доступ к этому хакатону закрыт.');
    const id=url.searchParams.get('team');
    if(id&&!canView(currentEventData().teams.find(t=>t.id===id),user)) return page(403,'Доступ к этой команде закрыт.');
    return page();
  }
  if(req.method!=='POST') return res.writeHead(405).end();
  try {
    check(req.headers['sec-fetch-site']!=='cross-site');
    const path=url.pathname.slice(1);
    if(path==='upload-case-file') check(canManage(user),'Прикреплять файлы может организатор мероприятия.');
    const form=await readForm(req,path==='upload-case-file');
    if(caseActions.has(path) && typeof form.get('caseId')==='string') url.searchParams.set('case',form.get('caseId'));
    if(path==='meeting' && form.get('team')) url.searchParams.set('meeting',form.get('team'));
    const reviewLogin=path==='review' && reviewEnabled();
    const quickLogin=reviewLogin || (demoMode && path==='demo-login');
    if(publicDemo && (path==='login' || path==='sign-up')) return redirect('/review');
    if(path==='login' || path==='sign-up' || quickLogin) {
      const signingUp=path==='sign-up';
      const email=(form.get('email')??'').trim().toLowerCase().slice(0,255);
      const name=(form.get('name')??'').slice(0,121);
      const password=form.get('password')??'';
      const role=form.get('role')??'participant';
      let record;
      try {
        limitLogin(req);
        check(password.length<=128,'Проверьте почту и пароль.',400);
        if(quickLogin) {
          if(reviewLogin && !publicDemo) check(matchesCode(reviewKey,form.get('reviewKey')),'Проверьте код для жюри.',403);
          const selected=form.get('account');
          if ([...demoAccounts.values()].includes(selected)) record=account(selected);
          check(record,'Выберите демо-аккаунт.',401);
        } else if(signingUp) {
          const next=structuredClone(state);
          check(['participant','organizer','mentor','expert'].includes(role),'Выберите роль.',400);
          if(['mentor','expert'].includes(role)) {
            const invitation=allHackathons(next).flatMap(([,data])=>data.invitations??[]).find(item=>item.code===(form.get('invite')??'').trim() && item.email===email && item.role===role && !item.used && !item.revoked && item.expires>Date.now());
            check(invitation,'Проверьте код, почту и роль. Приглашение должно быть действующим.',403);
            invitation.used=true;
          }
          if(role==='organizer' && !canBootstrap()) {
            check(matchesCode(organizerCode,form.get('invite')),'Чтобы зарегистрироваться организатором, нужен код приглашения.',403);
          }
          record=createAccount(next,role,name,email,password);
          persist(next);
        } else {
          record=authenticate(email,password);
          check(record,'Проверьте почту и пароль.',401);
        }
      } catch(error) {
        if(!(error instanceof RequestError)) throw error;
        return res.writeHead(error.code,{'Content-Type':'text/html; charset=utf-8'}).end(reviewLogin
          ? reviewPage(error.message)
          : signIn(error.message,signingUp,email,name,role,path==='login'));
      }
      if(record.role==='participant') {
        const next=structuredClone(state);
        next.accounts.find(item=>item.id===record.id).lastActivity=Date.now();
        persist(next);
      }
      sessions.delete(token);
      const session=randomUUID();
      sessions.set(session,{user:record.id,until:Date.now()+8*3600_000});
      res.setHeader('Set-Cookie',cookieName+'='+session+'; Max-Age=28800'+cookieFlags);
      if(record.role==='participant' && (signingUp ||
        (quickLogin && !platformTeam(record.id) && !memberTeam(currentEventData(),record.id)))) return redirect('/my-team');
      return redirect(quickLogin && record.role!=='organizer'?'/':'/hackathons');
    }
    if(path==='logout') {
      sessions.delete(token);
      res.setHeader('Set-Cookie',cookieName+'=; Max-Age=0'+cookieFlags);
      return redirect('/');
    }
    check(user,'Войдите в HackFlow.',401);
    if(path==='new-hackathon') {
      check(hasRole(user,'organizer'));
      if(!state.event.title && !state.owner && ownerOf(state)===user) {
        persist({...state,owner:user});
        return redirect('/?edit=event');
      }
      const id = randomUUID();
      persist({...state,hackathons:{...state.hackathons,[id]:{...emptyHackathon(),owner:user}}});
      return redirect('/?edit=event&hack='+id);
    }
    if(platformRoutes.has(path)) {
      check(isParticipant(user));
      changePlatformTeam(user,path,form);
      return redirect('/my-team');
    }
    if(path==='apply-team' || path==='withdraw-team') {
      check(isParticipant(user));
      const next=structuredClone(currentEventData());
      if(path==='apply-team') applyAsTeam(next,user,form.get('mode')==='solo',field(form,'caseId',120,false));
      else {
        const application=pendingApplications(next).find(item=>item.id===form.get('application'));
        check(application?.captain===user,'Отозвать заявку может капитан, который её подал.');
        application.status='withdrawn';
      }
      saveHackathon(next);
      return redirect(scopedUrl('/'));
    }
    if(hasRole(user,'organizer')) check(canManage(user),'Доступ к этому хакатону закрыт.');
    const upload=path==='upload-case-file'?await parseCaseUpload(form):undefined;
    const next=structuredClone(currentEventData());
    const location=hasRole(user,'organizer') ? organizerAction(next,path,form,upload) : isAdvisor(user) ? mentorAction(next,user,path,form) : participantAction(next,user,path,form);
    if(isParticipant(user)) {
      next.activity??={};
      next.activity[user]=Date.now();
    }
    saveHackathon(next);
    return redirect(scopedUrl(location));
  } catch(error) {
    if(error instanceof RequestError) {
      if(isParticipant(user) && platformRoutes.has(url.pathname.slice(1))) {
        return res.writeHead(error.code,{'Content-Type':'text/html; charset=utf-8'}).end(myTeamPage(user,error.message));
      }
      return page(error.code,error.message);
    }
    console.error(error);
    return page(500,'Сохранить изменения не удалось.');
  }
}
export function prepareDemo() {
  const now=Date.now();
  const data=seed();
  const create = (label, role, name) => {
    const person=createAccount(data,role,name,'demo-'+data.accounts.length+'@example.invalid',randomBytes(16).toString('hex'));
    if(label) demoAccounts.set(label,person.id);
    return person.id;
  };
  const organizer=create('Организатор','organizer','Нина Соколова');
  data.owner=organizer;
  Object.assign(data.event,{title:'Актион · студенческий хакатон',description:'Создайте рабочее пространство для команд студенческого хакатона.',rules:'Зарегистрируйте команду и сдайте ссылку на решение до дедлайна.',caseText:'Кейс №2. Спроектируйте цифровую среду для проведения студенческих хакатонов.',criteria:'Работа основного сценария, удобство и качество демонстрации.'});
  const captain=create('Капитан','participant','Максим Волков');
  const newcomer=create('Участник без команды','participant','Лена Орлова');
  const mentor=create('Ментор','mentor','Илья Серов');
  const teammate=create('Участник команды','participant','Анна Белова');
  const expert=create('Эксперт','expert','Ольга Миронова');
  data.platformTeams=[{id:randomUUID(),name:'Вектор',captain,members:[captain,teammate],code:'vectordemo'}];
  const orbitCaptain=create(null,'participant','София Лебедева');
  const pulseCaptain=create(null,'participant','Артём Ким');
  const orbitMember=create(null,'participant','Вера Морозова');
  const pulseMember=create(null,'participant','Денис Ли');
  data.event.published=true;
  data.event.minTeamSize=2;
  data.event.teamSize=4;
  data.event.start=now-3*3600_000;
  data.event.deadline=now+(publicMode?30*86400_000:90*60_000);
  data.poll=true;
  const demoTask = (name, description, owner, minutes, status) => ({
    id:randomUUID(), name, description, owner, due:now+minutes*60_000, status
  });
  data.teams.push({
    id:randomUUID(),name:'Вектор',captain,members:[captain,teammate],
    code:'vectordemo',registered:true,mentor,expert,
    tasks:[
      demoTask('Описать сценарий участника','Пройти путь от регистрации до сдачи.',teammate,25,3),
      demoTask('Проверить демо перед защитой','Запустить с отдельного аккаунта и проверить ссылки.',captain,55,1),
      demoTask('Подготовить слайды защиты','Показать задачу, сценарий и результаты проверки.',captain,65,0),
      demoTask('Сверить критерии оценки','Проверить, что в показе есть все ключевые шаги.',teammate,40,2),
      demoTask('Проверить мобильную версию','Пройти сценарий команды на узком экране.',teammate,45,1),
      demoTask('Записать резервное демо','Сохранить короткий показ на случай проблем со связью.',null,75,0)
    ],
    messages:[{author:teammate,body:'Сценарий участника готов. Давайте проверим его перед сдачей.',at:now-15*60_000}],
    feedback:[{author:mentor,body:'На защите покажите, как сдача появляется у организатора.',at:now-10*60_000}]
  });
  data.teams.push({
    id:randomUUID(), name:'Орбита', captain:orbitCaptain, members:[orbitCaptain,orbitMember],
    code:'orbitademo', registered:true, mentor,
    tasks:[demoTask('Проверить форму сдачи','Пройти сценарий и показать вопросы на чекпоинте.',orbitCaptain,45,2)],
    messages:[], feedback:[],
    checkpoint:{answer:'yes',topic:'Уточнить, какие материалы нужны для защиты'}
  },{
    id:randomUUID(), name:'Пульс', captain:pulseCaptain, members:[pulseCaptain,pulseMember],
    code:'pulsedemo', registered:true, expert,
    tasks:[demoTask('Собрать итоговые материалы','Подготовить описание и ссылку на пример решения.',pulseCaptain,-15,3)],
    messages:[], feedback:[],
    submission:{name:'Пульс · лента событий',description:'Единая лента расписания и обновлений для студенческих мероприятий.',link:'/demo-project',at:now-15*60_000},
    reviews:[{author:expert,body:'Сценарий показан последовательно. На защите поясните, как команда проверяла удобство интерфейса.',at:now-5*60_000}]
  });
  data.agenda.push(
    {id:randomUUID(),type:'Вебинар',name:'Как подготовить защиту',at:now+20*60_000,speaker:'Илья Серов',description:'Учебный пример. Ссылку на реальный эфир добавляет организатор.'},
    {id:randomUUID(),type:'Финальная защита',name:'Защита проектов',at:data.event.deadline+60*60_000},
    {id:randomUUID(),type:'Результаты',name:'Публикация результатов',at:data.event.deadline+3*3600_000}
  );
  data.resources.push({name:'Чек-лист подготовки защиты',description:'Что проверить перед сдачей и что показать жюри.',link:'/demo-guide'});
  for(const team of data.teams) for(const id of team.members) data.access[id]='admitted';
  notice(data,[captain,teammate],'Опубликованы материалы для участников','/#resources');
  notice(data,[captain],'Ответьте, нужен ли команде чекпоинт','/#checkpoint');
  const second=emptyHackathon();
  second.owner=organizer;
  Object.assign(second.event,{title:'Городские данные',description:'Хакатон по цифровым сервисам для горожан.',rules:'Соберите команду и сдайте ссылку на прототип.',caseText:'Помогите жителям понять, какие городские услуги доступны рядом с домом.',criteria:'Польза для жителей, доступность, качество прототипа.',minTeamSize:2,published:true});
  data.hackathons['city-data']=second;
  if(publicMode) second.event.deadline=now+30*86400_000;
  if(hostedReview) data.reviewRoles=[...demoAccounts];
  persist(data);
}

export function initializeHostedReview() {
  if(publicDemo) {
    if(!demoAccounts.size) prepareDemo();
    return;
  }
  if(!hostedReview) return;
  if(!state.accounts.length && !state.event.title && !Object.keys(state.hackathons??{}).length) prepareDemo();
  for(const [label,id] of state.reviewRoles??[]) demoAccounts.set(label,id);
}

if (calledDirectly) {
  if (demoMode) prepareDemo();
  if(process.argv[2]==='create-account') {
    const [, , , role, email='', name=''] = process.argv;
    try {
      check(!publicDemo,'У тестовых ролей в публичном демо уже есть аккаунты.',400);
      check(['organizer','mentor','expert'].includes(role),'Укажите роль organizer, mentor или expert.',400);
      const next=structuredClone(state);
      createAccount(next,role,name,email,process.env.HACKFLOW_NEW_PASSWORD??'');
      persist(next);
      console.log('Аккаунт создан: '+email);
    } catch(error) {
      console.error(error.message);
      process.exitCode=1;
    }
  } else {
  initializeHostedReview();
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3030);
  const server = http.createServer(handle);
  server.on('error', error => {
    if (error.code === 'EADDRINUSE' && process.env.PORT === undefined && host === '127.0.0.1') {
      console.log('Порт 3030 занят. Выбираю свободный локальный порт.');
      server.listen(0, host);
      return;
    }
    console.error('Не удалось запустить HackFlow: '+error.message);
    process.exitCode = 1;
  });
  server.on('listening', () => {
    const address = server.address();
    const browserHost = address.address === '0.0.0.0' ? '127.0.0.1' : address.family === 'IPv6' ? '['+address.address+']' : address.address;
    console.log('HackFlow: http://'+browserHost+':'+address.port+'/');
  });
  server.listen(port, host);
  }
}









