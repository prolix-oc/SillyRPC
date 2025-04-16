import bodyParser from 'body-parser';
import { Router } from 'express';
import { Chalk } from 'chalk';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import RPC from 'discord-rpc';

interface PluginInfo {
  id: string;
  name: string;
  description: string;
}

interface Plugin {
  init: (router: Router) => Promise<void>;
  exit: () => Promise<void>;
  info: PluginInfo;
}

interface Config {
  clientId: string;
  mode: 'local' | 'remote';
  agentUrl: string;
}

const chalk = new Chalk();
const MODULE_NAME = '[SillyRPC]';
const cfgPath = path.resolve(__dirname, 'config.json');
let config: Config = loadConfig();
let rpcClient: RPC.Client | null = null;
let wsClient: WebSocket | null = null;

function loadConfig(): Config {
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return JSON.parse(raw) as Config;
  } catch (err) {
    console.warn(chalk.yellow(MODULE_NAME), 'config.json not found or invalid, using defaults.');
    return { clientId: '', mode: 'local', agentUrl: '' };
  }
}

function saveConfig(newConfig: Config): void {
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2), 'utf8');
    console.log(chalk.green(MODULE_NAME), 'config.json updated');
  } catch (err) {
    console.error(chalk.red(MODULE_NAME), 'Failed to write config.json', err);
  }
}

function initLocalRpc(clientId: string): void {
  rpcClient = new RPC.Client({ transport: 'ipc' });
  RPC.register(clientId);
  rpcClient.on('ready', () => console.log(chalk.green(MODULE_NAME), 'Local RPC ready'));
  rpcClient.on('error', err => console.error(chalk.red(MODULE_NAME), 'Local RPC error', err));
  rpcClient.on('close', () => console.warn(chalk.yellow(MODULE_NAME), 'Local RPC transport closed'));
  rpcClient.login({ clientId }).catch(err => console.error(chalk.red(MODULE_NAME), 'Local RPC login failed', err));
}

function initRemoteWs(agentUrl: string): void {
  wsClient = new WebSocket(agentUrl);
  wsClient.on('open', () => console.log(chalk.green(MODULE_NAME), 'Connected to agent at', agentUrl));
  wsClient.on('error', err => console.error(chalk.red(MODULE_NAME), 'WS error', err));
}

function sendActivity(activity: Record<string, any>): void {
  if (config.mode === 'local') {
    if (!rpcClient) {
      console.error(chalk.red(MODULE_NAME), 'RPC client not initialized');
      return;
    }
    rpcClient.setActivity(activity);
  } else {
    if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
      console.error(chalk.red(MODULE_NAME), 'WebSocket client not connected');
      return;
    }
    wsClient.send(JSON.stringify(activity));
  }
}

export async function init(router: Router): Promise<void> {
  const jsonParser = bodyParser.json();

  console.log(chalk.green(MODULE_NAME), 'Plugin init, loaded config:', config);

  // Initialize transport based on mode
  if (config.mode === 'local') initLocalRpc(config.clientId);
  else initRemoteWs(config.agentUrl);

  // Health check
  router.post('/probe', (_req, res) => res.sendStatus(204));

  // Settings endpoints
  router.post('/settings', jsonParser, async (req, res) => {
    try {
      const { clientId, mode, agentUrl } = req.body as Config;
      config = { clientId, mode, agentUrl };
      saveConfig(config);
      // Re-init clients
      if (rpcClient) { rpcClient.destroy(); rpcClient = null; }
      if (wsClient) { wsClient.close(); wsClient = null; }
      if (config.mode === 'local') initLocalRpc(config.clientId);
      else initRemoteWs(config.agentUrl);
      return res.sendStatus(204);
    } catch (error) {
      console.error(chalk.red(MODULE_NAME), 'Settings update failed', error);
      return res.status(500).send('Internal Server Error');
    }
  });

  // Update presence from SillyTavern
  router.post('/update', jsonParser, async (req, res) => {
    try {
      console.log(chalk.blue(MODULE_NAME), '/update payload:', req.body);
      sendActivity({
        details: req.body.details,
        state: req.body.state,
        largeImageKey: req.body.largeImageKey,
        startTimestamp: req.body.startTimestamp,
      });
      return res.sendStatus(204);
    } catch (error) {
      console.error(chalk.red(MODULE_NAME), '/update error', error);
      return res.status(500).send('Internal Server Error');
    }
  });

  // Manual test endpoint
  router.post('/test', jsonParser, async (_req, res) => {
    const dummy = {
      details: 'Test Presence',
      state: 'Testing RPC',
      largeImageKey: 'test_image',
      startTimestamp: Date.now(),
    };
    console.log(chalk.blue(MODULE_NAME), '/test invoked');
    sendActivity(dummy);
    return res.json({ success: true, sent: dummy });
  });

  console.log(chalk.green(MODULE_NAME), 'Plugin loaded!');
}

export async function exit(): Promise<void> {
  console.log(chalk.yellow(MODULE_NAME), 'Plugin exited');
  if (rpcClient) rpcClient.destroy();
  if (wsClient) wsClient.close();
}

export const info: PluginInfo = {
  id: 'sillyrpc',
  name: 'Discord Rich Presence',
  description: 'Display SillyTavern chat presence via Discord Rich Presence'
};

const plugin: Plugin = {
  init,
  exit,
  info,
};

export default plugin;
