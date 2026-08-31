import { createRequire } from 'node:module';
import { join } from 'node:path';

/** Load shared runtime packages from the canonical Job Hunter workspace. */
const jobHunterHome = process.env.JOBHUNTER_HOME || join(process.env.HOME || process.cwd(), '.job-hunter');
const requireWorkspace = createRequire(join(jobHunterHome, 'package.json'));

export const WebSocketModule = requireWorkspace('ws');
export const WebSocket = WebSocketModule.WebSocket || WebSocketModule;
export const WebSocketServer = WebSocketModule.WebSocketServer;
export const Database = requireWorkspace('better-sqlite3');
