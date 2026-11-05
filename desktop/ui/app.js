const { invoke } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const WIDTH = 275;
const canvas = document.getElementById('winamp');
const paint = canvas.getContext('2d');
const loading = document.getElementById('loading');

// ---- Winamp windows: the engine draws them, this only shows the pixels.

let wake = null;

async function drawFrame() {
  let delay = 500;
  try {
    const bytes = new Uint8Array(await invoke('frame'));
    if (bytes.length > 3) {
      const height = bytes[1] | (bytes[2] << 8);
      if (canvas.height !== height) {
        canvas.height = height;
        fit();
      }
      const pixels = new Uint8ClampedArray(bytes.buffer, 3, WIDTH * height * 4);
      paint.putImageData(new ImageData(pixels, WIDTH, height), 0, 0);
      loading.hidden = true;
      canvas.classList.remove('waiting');
    } else if (bytes.length === 0) {
      canvas.classList.add('waiting');
    }
    if (bytes.length > 0) delay = bytes[0] & 1 ? 50 : 250;
  } catch (e) {
    console.error(e);
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, delay);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  drawFrame();
}

function fit() {
  // 2x when it fits; smaller on low screens.
  const scale = Math.min(2, innerHeight / canvas.height);
  canvas.style.width = `${WIDTH * scale}px`;
  canvas.style.height = `${canvas.height * scale}px`;
}

addEventListener('resize', fit);

function pixelAt(event) {
  const box = canvas.getBoundingClientRect();
  const clamp = (v, max) => Math.max(0, Math.min(max - 1, Math.floor(v)));
  return {
    x: clamp((event.clientX - box.left) * canvas.width / box.width, canvas.width),
    y: clamp((event.clientY - box.top) * canvas.height / box.height, canvas.height),
  };
}

async function send(kind, { x, y }) {
  const openFiles = await invoke('mouse', { kind, x, y });
  if (wake) wake();
  if (openFiles) addMusic(false);
}

let pressed = false;

canvas.addEventListener('pointerdown', (event) => {
  const at = pixelAt(event);
  // The main window's title bar moves the app; its buttons sit at the edges.
  if (at.y < 14 && at.x >= 16 && at.x < 244) {
    appWindow.startDragging();
    return;
  }
  if (at.y < 14 && at.x >= 244 && at.x < 254) {
    appWindow.minimize();
    return;
  }
  pressed = true;
  canvas.setPointerCapture(event.pointerId);
  send('down', at);
});

canvas.addEventListener('pointermove', (event) => {
  if (pressed) send('drag', pixelAt(event));
});

canvas.addEventListener('pointerup', (event) => {
  if (!pressed) return;
  pressed = false;
  send('up', pixelAt(event));
});

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  send(event.deltaY < 0 ? 'wheel-up' : 'wheel-down', pixelAt(event));
}, { passive: false });

// ---- Library: the same search the remote-control protocol offers.

const tabs = [...document.querySelectorAll('[role=tab]')];
const query = document.getElementById('query');
const chips = document.getElementById('chips');
const add = document.getElementById('add');
const results = document.getElementById('results');
const message = document.getElementById('message');

const form = document.getElementById('search');

const SOURCES = {
  local: { placeholder: 'Zoek in je muziek', live: true, empty: 'Geen muziek gevonden. Voeg bestanden of een map toe.' },
  radio: { placeholder: 'Zoek een radiostation', start: 'jazz', chips: ['Jazz', 'Hawaii', 'Lofi', 'Klassiek', 'Nieuws', 'NPO'], empty: 'Geen stations gevonden. Probeer een andere zoekterm.' },
};

let source = 'local';
let searchId = 0;

async function ask(payload) {
  const reply = JSON.parse(await invoke('request', { line: JSON.stringify(payload) }));
  if (reply.error) throw new Error(reply.error);
  return reply;
}

function say(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

function clock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function row(hit, text) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = hit.title;
  button.append(title);
  const detail = [hit.artist, hit.album].filter(Boolean).join(' - ') || hit.subtitle;
  if (detail) {
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = detail;
    button.append(sub);
  }
  if (hit.duration) {
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = clock(hit.duration);
    button.append(time);
  }
  button.addEventListener('click', () => play(hit, text));
  item.append(button);
  return item;
}

async function search(text) {
  const id = ++searchId;
  const from = source;
  say('Zoeken...');
  try {
    const reply = await ask({ search: { source: from, query: text, limit: from === 'local' ? 500 : 30, then: 'show' } });
    if (id !== searchId) return;
    results.replaceChildren(...reply.results.map((hit) => row(hit, text)));
    say(reply.results.length ? '' : SOURCES[from].empty);
  } catch (e) {
    if (id === searchId) say(e.message, true);
  }
}

async function play(hit, text) {
  say(`${hit.title} starten...`);
  try {
    // ponytail: repeats the search, as `search --play N` does; results that
    // changed in between start another row. Queue by id if that ever bites.
    await ask({ search: { source, query: text, limit: source === 'local' ? 500 : 30, then: { play: hit.index } } });
    say('');
  } catch (e) {
    say(e.message, true);
  }
}

async function showSkins() {
  say('');
  const names = await invoke('skins');
  results.replaceChildren(...names.map((name) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = name;
    button.append(title);
    button.addEventListener('click', async () => {
      try {
        await ask({ skin: name });
        say(`Skin ${name} gekozen.`);
        if (wake) wake();
      } catch (e) {
        say(e.message, true);
      }
    });
    item.append(button);
    return item;
  }));
}

function show(next) {
  source = next;
  form.hidden = next === 'skins';
  if (next === 'skins') {
    tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.source === next)));
    add.hidden = true;
    chips.hidden = true;
    results.replaceChildren();
    showSkins();
    return;
  }
  const config = SOURCES[next];
  tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.source === next)));
  query.placeholder = config.placeholder;
  query.value = '';
  add.hidden = next !== 'local';
  chips.hidden = !config.chips;
  chips.replaceChildren(...(config.chips || []).map((label) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = label;
    chip.addEventListener('click', () => { query.value = label; search(label); });
    return chip;
  }));
  results.replaceChildren();
  say('');
  if (next === 'local') search('');
  else if (config.start) search(config.start);
}

async function addMusic(folder) {
  try {
    const count = await invoke('add_music', { folder });
    if (count) say('Toegevoegd aan de afspeellijst.');
  } catch (e) {
    say(String(e), true);
  }
}

tabs.forEach((tab) => tab.addEventListener('click', () => show(tab.dataset.source)));
document.getElementById('add-files').addEventListener('click', () => addMusic(false));
document.getElementById('add-folder').addEventListener('click', () => addMusic(true));

document.getElementById('search').addEventListener('submit', (event) => {
  event.preventDefault();
  search(query.value.trim());
});

let typing;
query.addEventListener('input', () => {
  if (!SOURCES[source].live) return;
  clearTimeout(typing);
  typing = setTimeout(() => search(query.value.trim()), 150);
});

show('local');
drawFrame();
