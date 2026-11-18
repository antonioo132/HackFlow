const board = document.querySelector('.board');
let card;
if (board) {
  const lanes = [...board.querySelectorAll('[data-lane]')];
  function clearHighlight() {
    for (const lane of lanes) lane.classList.remove('is-drop-target');
  }
  board.addEventListener('dragstart', event => {
    card = event.target.closest('[data-movable]');
    if (!card || !event.dataTransfer) return;
    event.dataTransfer.setData('text/plain', card.querySelector('[name=id]').value);
    event.dataTransfer.effectAllowed = 'move';
  });
  board.addEventListener('dragover', event => {
    const lane = event.target.closest('[data-lane]');
    if (!card || !lane) return;
    event.preventDefault();
    clearHighlight();
    lane.classList.add('is-drop-target');
  });
  board.addEventListener('drop', event => {
    const lane = event.target.closest('[data-lane]');
    if (!card || !lane) return;
    event.preventDefault();
    const form = card.querySelector('.task-move');
    const status = form.elements.namedItem('status');
    if (status.value !== lane.dataset.lane) {
      status.value = lane.dataset.lane;
      form.requestSubmit();
    }
    card = null;
    clearHighlight();
  });
  board.addEventListener('dragend', () => {
    card = null;
    clearHighlight();
  });
}


const registrationRole=document.querySelector('form[action="/sign-up"] select[name="role"]');
if(registrationRole){
  const invitation=document.querySelector('[data-invite-field]');
  const update=()=>{
    invitation.hidden=!['mentor','expert'].includes(registrationRole.value);
  };
  registrationRole.addEventListener('change',update);update();
}
for(const form of document.querySelectorAll('form[method="post"]')){
  if(!['/revoke','/kick','/leave','/revoke-invite','/platform-kick','/platform-leave','/reject-team','/withdraw-team'].includes(new URL(form.action).pathname)) continue;
  form.addEventListener('submit',event=>{if(!window.confirm('Подтвердить действие: '+form.querySelector('button').textContent+'?'))event.preventDefault();});
}

const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const themeControls = [...document.querySelectorAll('[data-theme-mode]')];
let themeMode = 'system';
try {
  const savedTheme = localStorage.getItem('hackflow.theme');
  if (['system','light','dark'].includes(savedTheme)) themeMode = savedTheme;
} catch {}

function applyTheme() {
  const dark = themeMode === 'dark' || (themeMode === 'system' && systemTheme.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  for (const button of themeControls) {
    button.setAttribute('aria-pressed', String(button.dataset.themeMode === themeMode));
  }
}
applyTheme();
systemTheme.addEventListener('change', applyTheme);
for (const button of themeControls) {
  button.closest('[data-theme-control]').hidden = false;
  button.addEventListener('click', () => {
    themeMode = button.dataset.themeMode;
    try { localStorage.setItem('hackflow.theme', themeMode); } catch {}
    applyTheme();
  });
}

for (const panel of document.querySelectorAll('.board-panel')) {
  const toolbar = panel.querySelector('[data-task-toolbar]');
  const query = panel.querySelector('[data-task-query]');
  const statusFilter = panel.querySelector('[data-task-status-filter]');
  const mine = panel.querySelector('[data-task-mine-filter]');
  const modes = [...panel.querySelectorAll('[data-task-mode]')];
  const list = panel.querySelector('.task-list-view');
  const kanban = panel.querySelector('.board');
  const rows = [...list.querySelectorAll('.task-row')];
  const details = [...list.querySelectorAll('[data-task-detail]')];
  const lanes = [...kanban.querySelectorAll('[data-lane]')];
  const items = [...panel.querySelectorAll('[data-task-search]')];
  let selected = new URLSearchParams(window.location.search).get('task');
  let mode = 'board';
  try {
    if (localStorage.getItem('hackflow.task-view') === 'list') mode = 'list';
  } catch {}

  function selectTask(key) {
    selected = key;
    for (const row of rows) row.setAttribute('aria-pressed', String(row.dataset.taskKey === key));
    for (const detail of details) detail.hidden = detail.dataset.taskDetail !== key;
    list.querySelector('[data-task-empty]').hidden = Boolean(key);
  }
  function filterTasks() {
    const term = query.value.trim().toLocaleLowerCase('ru');
    for (const item of items) {
      const { taskStatus, taskMine, taskSearch } = item.dataset;
      item.hidden = Boolean(
        (term && !taskSearch.toLocaleLowerCase('ru').includes(term)) ||
        (statusFilter.value && taskStatus !== statusFilter.value) ||
        (mine?.checked && taskMine !== 'true')
      );
    }
    for (const lane of lanes) {
      const count = lane.querySelectorAll('.task:not([hidden])').length;
      lane.querySelector('[data-lane-count]').textContent = count;
      lane.querySelector('.lane-empty').hidden = count > 0;
    }
    const visible = rows.filter(row => !row.hidden);
    selectTask(visible.some(row => row.dataset.taskKey === selected) ? selected : visible[0]?.dataset.taskKey);
  }
  function showView() {
    kanban.hidden = mode === 'list';
    list.hidden = mode === 'board';
    for (const button of modes) button.setAttribute('aria-pressed', String(button.dataset.taskMode === mode));
  }
  toolbar.hidden = false;
  query.addEventListener('input', filterTasks);
  statusFilter.addEventListener('change', filterTasks);
  mine?.addEventListener('change', filterTasks);
  for (const row of rows) row.addEventListener('click', () => selectTask(row.dataset.taskKey));
  for (const button of modes) button.addEventListener('click', () => {
    mode = button.dataset.taskMode;
    try { localStorage.setItem('hackflow.task-view', mode); } catch {}
    showView();
  });
  filterTasks();
  showView();
  if (selected && new URLSearchParams(window.location.search).has('task')) {
    const task = [...kanban.querySelectorAll('[data-task-card]')].find(item=>item.dataset.taskCard===selected);
    if (task) task.querySelector('details').open = true;
  }
}

const checkpointPanel = document.querySelector('[data-checkpoint-update]');
if(checkpointPanel) {
  let checking = false;
  let lastMarkup;
  async function refreshCheckpoint() {
    if (document.hidden || checking) return;
    checking = true;
    try {
      const response = await fetch(checkpointPanel.dataset.checkpointUpdate);
      if (!response.ok || response.status === 204) return;
      const markup = await response.text();
      if (markup === lastMarkup) return;
      lastMarkup = markup;
      const fragment = document.createElement('template');
      fragment.innerHTML = markup;
      if (fragment.innerHTML !== checkpointPanel.innerHTML) {
        checkpointPanel.replaceChildren(fragment.content);
      }
    } catch {
      // A later refresh can pick up the update after a temporary connection failure.
    } finally {
      checking = false;
    }
  }
  setInterval(refreshCheckpoint,8000);
  document.addEventListener('visibilitychange',refreshCheckpoint);
}

const eventFormat = document.querySelector('select[name="format"]');
const programmingSettings = eventFormat?.form?.querySelector('[data-programming-settings]');
if (programmingSettings) {
  const updateFormat=()=>{ programmingSettings.hidden=eventFormat.value!=='programming'; };
  eventFormat.addEventListener('change',updateFormat);
  updateFormat();
}
