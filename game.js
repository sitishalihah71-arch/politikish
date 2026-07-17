// App entry point. Bootstraps the UI; later modules (room.js, multiplayer.js,
// player.js, etc.) will register their own `bus` listeners as they land.

import { initUI } from './ui.js';

initUI();
