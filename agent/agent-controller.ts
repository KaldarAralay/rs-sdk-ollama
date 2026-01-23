#!/usr/bin/env bun
// Agent Controller Service - Routes between UI and Agent Service
// This is a thin router that forwards commands to rsbot-agent-sdk.ts

import { RunRecorder, type RunEvent } from './run-recorder';

const CONTROLLER_PORT = parseInt(process.env.CONTROLLER_PORT || '7781');
const AGENT_SERVICE_PORT = parseInt(process.env.AGENT_SERVICE_PORT || '7782');
const SYNC_PORT = parseInt(process.env.AGENT_PORT || '7780');

interface ActionLogEntry {
    timestamp: number;
    type: 'thinking' | 'action' | 'result' | 'error' | 'system' | 'user_message' | 'code' | 'state';
    content: string;
}

interface AgentState {
    running: boolean;
    sessionId: string | null;
    goal: string | null;
    startedAt: number | null;
    actionLog: ActionLogEntry[];
}

// Per-bot session tracking (UI state only - agent service manages actual sessions)
interface BotSession {
    state: AgentState;
    uiClients: Set<any>;
    recorder: RunRecorder | null;  // Run recorder for this session
}

const botSessions = new Map<string, BotSession>();
const wsToUsername = new Map<any, string>();

// Connection to agent service
let agentServiceWs: WebSocket | null = null;
let agentServiceConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Connection to sync service for screenshots
let syncServiceWs: WebSocket | null = null;
let syncServiceConnected = false;
let syncReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function getOrCreateSession(username: string): BotSession {
    let session = botSessions.get(username);
    if (!session) {
        session = {
            state: {
                running: false,
                sessionId: null,
                goal: null,
                startedAt: null,
                actionLog: []
            },
            uiClients: new Set(),
            recorder: null
        };
        botSessions.set(username, session);
    }
    return session;
}

function broadcastToBot(username: string, message: any) {
    const session = botSessions.get(username);
    if (!session) return;

    const data = JSON.stringify(message);
    for (const client of session.uiClients) {
        try {
            client.send(data);
        } catch (e) {
            // Client disconnected
        }
    }
}

function addLogEntryForBot(username: string, type: ActionLogEntry['type'], content: string) {
    const session = getOrCreateSession(username);
    const entry: ActionLogEntry = {
        timestamp: Date.now(),
        type,
        content
    };
    session.state.actionLog.push(entry);

    // Keep last 200 entries
    if (session.state.actionLog.length > 200) {
        session.state.actionLog = session.state.actionLog.slice(-200);
    }

    broadcastToBot(username, { type: 'log', entry });

    // Log to run recorder if recording
    if (session.recorder?.isRecording()) {
        session.recorder.logEvent({
            timestamp: entry.timestamp,
            type: entry.type as RunEvent['type'],
            content: entry.content
        });
    }
}

// ============ Agent Service Connection ============

function connectToAgentService() {
    if (agentServiceWs && agentServiceWs.readyState === WebSocket.OPEN) {
        return;
    }

    console.log(`[Controller] Connecting to agent service at ws://localhost:${AGENT_SERVICE_PORT}...`);

    try {
        agentServiceWs = new WebSocket(`ws://localhost:${AGENT_SERVICE_PORT}`);

        agentServiceWs.onopen = () => {
            console.log('[Controller] Connected to agent service');
            agentServiceConnected = true;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        };

        agentServiceWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(String(event.data));
                handleAgentServiceMessage(msg);
            } catch (e) {
                console.error('[Controller] Error parsing agent service message:', e);
            }
        };

        agentServiceWs.onclose = () => {
            console.log('[Controller] Disconnected from agent service');
            agentServiceConnected = false;
            agentServiceWs = null;
            scheduleReconnect();
        };

        agentServiceWs.onerror = (error) => {
            console.error('[Controller] Agent service connection error');
            agentServiceConnected = false;
        };

    } catch (e) {
        console.error('[Controller] Failed to connect to agent service:', e);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToAgentService();
    }, 3000);
}

function sendToAgentService(message: object) {
    if (!agentServiceWs || !agentServiceConnected) {
        console.log('[Controller] Agent service not connected, cannot send message');
        return false;
    }
    try {
        agentServiceWs.send(JSON.stringify(message));
        return true;
    } catch (e) {
        console.error('[Controller] Failed to send to agent service:', e);
        return false;
    }
}

function handleAgentServiceMessage(msg: any) {
    const username = msg.username;
    if (!username) return;

    const session = getOrCreateSession(username);

    // Map agent service message types to log entries
    switch (msg.type) {
        case 'thinking':
            addLogEntryForBot(username, 'thinking', msg.content);
            break;

        case 'action':
            addLogEntryForBot(username, 'action', msg.content);
            break;

        case 'code':
            addLogEntryForBot(username, 'code', msg.content);
            break;

        case 'result':
            addLogEntryForBot(username, 'result', msg.content);
            break;

        case 'error':
            addLogEntryForBot(username, 'error', msg.content);
            break;

        case 'system':
            addLogEntryForBot(username, 'system', msg.content);
            break;

        case 'state':
            addLogEntryForBot(username, 'state', msg.content);
            break;

        case 'todos':
            // Forward todo list updates directly to UI
            broadcastToBot(username, {
                type: 'todos',
                todos: msg.todos
            });
            break;

        case 'status':
            if (msg.status === 'running') {
                session.state.running = true;
                broadcastToBot(username, {
                    type: 'status',
                    status: 'running',
                    goal: session.state.goal
                });
            } else if (msg.status === 'stopped' || msg.status === 'idle') {
                session.state.running = false;
                broadcastToBot(username, {
                    type: 'status',
                    status: 'stopped'
                });
            }
            break;
    }
}

// ============ Sync Service Connection (for screenshots) ============

function connectToSyncService() {
    if (syncServiceWs && syncServiceWs.readyState === WebSocket.OPEN) {
        return;
    }

    console.log(`[Controller] Connecting to sync service at ws://localhost:${SYNC_PORT}...`);

    try {
        syncServiceWs = new WebSocket(`ws://localhost:${SYNC_PORT}`);

        syncServiceWs.onopen = () => {
            console.log('[Controller] Connected to sync service');
            syncServiceConnected = true;
            // Register as a controller client
            syncServiceWs?.send(JSON.stringify({
                type: 'controller_connect',
                clientId: 'agent-controller'
            }));
            if (syncReconnectTimer) {
                clearTimeout(syncReconnectTimer);
                syncReconnectTimer = null;
            }
        };

        syncServiceWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(String(event.data));
                handleSyncServiceMessage(msg);
            } catch (e) {
                console.error('[Controller] Error parsing sync service message:', e);
            }
        };

        syncServiceWs.onclose = () => {
            console.log('[Controller] Disconnected from sync service');
            syncServiceConnected = false;
            syncServiceWs = null;
            scheduleSyncReconnect();
        };

        syncServiceWs.onerror = () => {
            console.error('[Controller] Sync service connection error');
            syncServiceConnected = false;
        };

    } catch (e) {
        console.error('[Controller] Failed to connect to sync service:', e);
        scheduleSyncReconnect();
    }
}

function scheduleSyncReconnect() {
    if (syncReconnectTimer) return;
    syncReconnectTimer = setTimeout(() => {
        syncReconnectTimer = null;
        connectToSyncService();
    }, 3000);
}

function sendToSyncService(message: object) {
    if (!syncServiceWs || !syncServiceConnected) {
        return false;
    }
    try {
        syncServiceWs.send(JSON.stringify(message));
        return true;
    } catch (e) {
        console.error('[Controller] Failed to send to sync service:', e);
        return false;
    }
}

function requestScreenshot(username: string) {
    sendToSyncService({
        type: 'screenshot_request',
        username
    });
}

function handleSyncServiceMessage(msg: any) {
    // Handle screenshot response
    if (msg.type === 'screenshot_response') {
        const { username, dataUrl } = msg;
        if (!username || !dataUrl) return;

        const session = botSessions.get(username);
        if (session?.recorder?.isRecording()) {
            session.recorder.saveScreenshot(dataUrl);
        }
    }
}

// ============ Bot Agent Control Functions ============

function startAgentForBot(username: string, goal: string) {
    console.log(`[Controller] [${username}] startAgent called with goal: ${goal}`);

    const session = getOrCreateSession(username);
    session.state.goal = goal;
    session.state.startedAt = Date.now();
    session.state.actionLog = [];
    session.state.running = true;

    // Stop any existing recording and start fresh
    if (session.recorder?.isRecording()) {
        session.recorder.stopRun();
    }

    // Start new recording
    session.recorder = new RunRecorder();
    const screenshotCallback = () => requestScreenshot(username);
    session.recorder.startRun(username, goal, screenshotCallback);

    addLogEntryForBot(username, 'system', `Starting agent with goal: ${goal}`);

    broadcastToBot(username, {
        type: 'status',
        status: 'starting',
        goal
    });

    // Send start command to agent service
    const sent = sendToAgentService({
        type: 'start',
        username,
        goal
    });

    if (!sent) {
        addLogEntryForBot(username, 'error', 'Agent service not available. Make sure rsbot-agent-sdk.ts is running.');
        session.state.running = false;
        if (session.recorder?.isRecording()) {
            session.recorder.stopRun();
        }
        broadcastToBot(username, {
            type: 'status',
            status: 'stopped'
        });
    }
}

function stopAgentForBot(username: string) {
    const session = botSessions.get(username);
    if (!session) return;

    addLogEntryForBot(username, 'system', 'Stopping agent...');

    sendToAgentService({
        type: 'stop',
        username
    });

    session.state.running = false;

    // Stop recording and generate transcript
    if (session.recorder?.isRecording()) {
        session.recorder.stopRun();
    }

    broadcastToBot(username, {
        type: 'status',
        status: 'stopped'
    });
}

function sendMessageForBot(username: string, message: string) {
    const session = getOrCreateSession(username);
    console.log(`[Controller] [${username}] sendMessageForBot called, running=${session.state.running}`);

    // Log the user message
    addLogEntryForBot(username, 'user_message', message);

    if (session.state.running) {
        // Send message to running agent
        const sent = sendToAgentService({
            type: 'message',
            username,
            message
        });

        if (sent) {
            addLogEntryForBot(username, 'system', 'Message sent to agent');
        } else {
            addLogEntryForBot(username, 'error', 'Failed to send message - agent service not available');
        }
    } else {
        // Agent not running - start it with this message as the goal
        addLogEntryForBot(username, 'system', 'Agent not running. Starting agent with your message...');
        startAgentForBot(username, message);
    }
}

// ============ UI Message Handler ============

function handleUIMessage(ws: any, data: string) {
    let message;
    try {
        message = JSON.parse(data);
    } catch {
        return;
    }

    const username = wsToUsername.get(ws) || 'default';
    const session = getOrCreateSession(username);

    switch (message.type) {
        case 'start':
            if (message.goal) {
                startAgentForBot(username, message.goal);
            }
            break;

        case 'stop':
            stopAgentForBot(username);
            break;

        case 'restart':
            if (session.state.goal) {
                startAgentForBot(username, session.state.goal);
            }
            break;

        case 'send':
            if (message.message) {
                sendMessageForBot(username, message.message);
            }
            break;

        case 'getState':
            ws.send(JSON.stringify({
                type: 'state',
                ...session.state
            }));
            break;

        case 'clearLog':
            session.state.actionLog = [];
            broadcastToBot(username, { type: 'logCleared' });
            break;
    }
}

// ============ WebSocket Server ============

console.log(`[Controller] Starting Agent Controller on port ${CONTROLLER_PORT}...`);

const server = Bun.serve({
    port: CONTROLLER_PORT,

    async fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket upgrade
        if (req.headers.get('upgrade') === 'websocket') {
            const botUsername = url.searchParams.get('bot') || 'default';
            const upgraded = server.upgrade(req, { data: { botUsername } });
            if (upgraded) return undefined;
            return new Response('WebSocket upgrade failed', { status: 400 });
        }

        // CORS headers
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        };

        if (req.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const botUsername = url.searchParams.get('bot') || 'default';

        // HTTP API endpoints
        if (url.pathname === '/status') {
            if (botUsername === 'all') {
                const allBots: Record<string, any> = {};
                for (const [name, session] of botSessions) {
                    allBots[name] = {
                        running: session.state.running,
                        sessionId: session.state.sessionId,
                        goal: session.state.goal,
                        startedAt: session.state.startedAt,
                        logCount: session.state.actionLog.length
                    };
                }
                return new Response(JSON.stringify({
                    bots: allBots,
                    count: botSessions.size,
                    agentServiceConnected
                }), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            }
            const session = getOrCreateSession(botUsername);
            return new Response(JSON.stringify({
                bot: botUsername,
                running: session.state.running,
                sessionId: session.state.sessionId,
                goal: session.state.goal,
                startedAt: session.state.startedAt,
                logCount: session.state.actionLog.length,
                agentServiceConnected
            }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        if (url.pathname === '/log') {
            const session = getOrCreateSession(botUsername);
            return new Response(JSON.stringify(session.state.actionLog), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        if (url.pathname === '/start' && req.method === 'POST') {
            try {
                const body = await req.json() as { goal?: string };
                if (body.goal) {
                    startAgentForBot(botUsername, body.goal);
                    return new Response(JSON.stringify({ ok: true, bot: botUsername }), {
                        headers: { 'Content-Type': 'application/json', ...corsHeaders }
                    });
                } else {
                    return new Response(JSON.stringify({ ok: false, error: 'No goal provided' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json', ...corsHeaders }
                    });
                }
            } catch (err: any) {
                return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            }
        }

        if (url.pathname === '/stop' && req.method === 'POST') {
            stopAgentForBot(botUsername);
            return new Response(JSON.stringify({ ok: true, bot: botUsername }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        return new Response(`Agent Controller API (Multi-Bot)

Endpoints:
- GET /status?bot=<name>  (or ?bot=all for all bots)
- GET /log?bot=<name>
- POST /start?bot=<name> {goal}
- POST /stop?bot=<name>
- WebSocket?bot=<name> for real-time updates

Agent Service: ${agentServiceConnected ? 'Connected' : 'Disconnected'}
`, {
            headers: { 'Content-Type': 'text/plain', ...corsHeaders }
        });
    },

    websocket: {
        open(ws: any) {
            const botUsername = ws.data?.botUsername || 'default';
            const session = getOrCreateSession(botUsername);

            session.uiClients.add(ws);
            wsToUsername.set(ws, botUsername);

            console.log(`[Controller] [${botUsername}] UI client connected (${session.uiClients.size} for this bot)`);

            // Send current state
            ws.send(JSON.stringify({
                type: 'state',
                ...session.state,
                agentServiceConnected
            }));
        },

        message(ws: any, message: any) {
            handleUIMessage(ws, message.toString());
        },

        close(ws: any) {
            const username = wsToUsername.get(ws);
            if (username) {
                const session = botSessions.get(username);
                if (session) {
                    session.uiClients.delete(ws);
                    console.log(`[Controller] [${username}] UI client disconnected (${session.uiClients.size} for this bot)`);

                    // Clean up when last client disconnects
                    if (session.uiClients.size === 0) {
                        if (session.state.running) {
                            stopAgentForBot(username);
                        }
                        botSessions.delete(username);
                        console.log(`[Controller] [${username}] Session cleared`);
                    }
                }
                wsToUsername.delete(ws);
            }
        }
    }
});

// Connect to agent service and sync service on startup
connectToAgentService();
connectToSyncService();

console.log(`[Controller] Agent Controller running at http://localhost:${CONTROLLER_PORT}`);
console.log(`[Controller] WebSocket endpoint: ws://localhost:${CONTROLLER_PORT}?bot=<username>`);
console.log(`[Controller] Agent service: ws://localhost:${AGENT_SERVICE_PORT}`);
console.log(`[Controller] Sync service: ws://localhost:${SYNC_PORT}`);
console.log(`[Controller] Runs recorded to: ./runs/`);
