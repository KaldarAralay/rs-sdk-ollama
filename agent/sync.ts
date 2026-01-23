// State Sync Service - Pure WebSocket message router
// Routes messages between SDK clients and bot game clients
// No file I/O - everything flows through WebSocket

import type {
    BotWorldState,
    BotAction,
    ActionResult,
    BotClientMessage,
    SyncToBotMessage,
    SDKMessage,
    SyncToSDKMessage
} from './types';

const AGENT_PORT = parseInt(process.env.AGENT_PORT || '7780');

// ============ Session Types ============

interface BotSession {
    ws: any;
    clientId: string;
    username: string;
    lastState: BotWorldState | null;
    currentActionId: string | null;  // Action being executed
}

interface SDKSession {
    ws: any;
    sdkClientId: string;
    targetUsername: string;
}

interface ControllerSession {
    ws: any;
    clientId: string;
}

// ============ Session Maps ============

const botSessions = new Map<string, BotSession>();      // username -> BotSession
const sdkSessions = new Map<string, SDKSession>();      // sdkClientId -> SDKSession
const controllerSessions = new Map<string, ControllerSession>();  // clientId -> ControllerSession
const wsToType = new Map<any, { type: 'bot' | 'sdk' | 'controller'; id: string }>();

// ============ Helper Functions ============

function sendToBot(session: BotSession, message: SyncToBotMessage) {
    if (session.ws) {
        try {
            session.ws.send(JSON.stringify(message));
        } catch (error) {
            console.error(`[Sync] [${session.username}] Failed to send to bot:`, error);
        }
    }
}

function sendToSDK(session: SDKSession, message: SyncToSDKMessage) {
    if (session.ws) {
        try {
            session.ws.send(JSON.stringify(message));
        } catch (error) {
            console.error(`[Sync] [${session.sdkClientId}] Failed to send to SDK:`, error);
        }
    }
}

function sendToController(session: ControllerSession, message: any) {
    if (session.ws) {
        try {
            session.ws.send(JSON.stringify(message));
        } catch (error) {
            console.error(`[Sync] [${session.clientId}] Failed to send to controller:`, error);
        }
    }
}

// Get all SDK sessions watching a specific bot
function getSDKSessionsForBot(username: string): SDKSession[] {
    const sessions: SDKSession[] = [];
    for (const session of sdkSessions.values()) {
        if (session.targetUsername === username) {
            sessions.push(session);
        }
    }
    return sessions;
}

// Extract username from clientId if it contains one
function extractUsernameFromClientId(clientId: string | undefined): string | null {
    if (!clientId) return null;
    if (clientId.startsWith('bot-')) return null;
    const parts = clientId.split('-');
    if (parts.length >= 1 && parts[0] && !parts[0].match(/^\d+$/)) {
        return parts[0];
    }
    return null;
}

// ============ Message Handlers ============

function handleBotMessage(ws: any, data: string) {
    let message: BotClientMessage;
    try {
        message = JSON.parse(data);
    } catch {
        console.error('[Sync] Invalid JSON from bot client');
        return;
    }

    // Handle connection message
    if (message.type === 'connected') {
        const username = message.username || extractUsernameFromClientId(message.clientId) || 'default';
        const clientId = message.clientId || `bot-${Date.now()}`;

        // Close old connection if exists
        const existingSession = botSessions.get(username);
        if (existingSession && existingSession.ws !== ws) {
            try {
                existingSession.ws?.close();
            } catch {}
        }

        const session: BotSession = {
            ws,
            clientId,
            username,
            lastState: existingSession?.lastState || null,
            currentActionId: null
        };

        botSessions.set(username, session);
        wsToType.set(ws, { type: 'bot', id: username });

        console.log(`[Sync] Bot client connected: ${clientId} (username: ${username})`);

        sendToBot(session, {
            type: 'status',
            status: 'Connected to sync service'
        });

        // Notify any waiting SDK clients that the bot is now connected
        for (const sdkSession of getSDKSessionsForBot(username)) {
            sendToSDK(sdkSession, {
                type: 'sdk_connected',
                success: true
            });
        }
        return;
    }

    // For other messages, look up session by WebSocket
    const wsInfo = wsToType.get(ws);
    if (!wsInfo || wsInfo.type !== 'bot') {
        console.error('[Sync] Received message from unknown bot WebSocket');
        return;
    }

    const session = botSessions.get(wsInfo.id);
    if (!session) {
        console.error(`[Sync] No session found for bot: ${wsInfo.id}`);
        return;
    }

    // Handle action result
    if (message.type === 'actionResult' && message.result) {
        const actionId = message.actionId || session.currentActionId;

        console.log(`[Sync] [${session.username}] Action result: ${message.result.success ? 'success' : 'failed'} - ${message.result.message}`);

        // Forward result to SDK sessions
        for (const sdkSession of getSDKSessionsForBot(session.username)) {
            sendToSDK(sdkSession, {
                type: 'sdk_action_result',
                actionId,
                result: message.result
            });
        }

        session.currentActionId = null;
        return;
    }

    // Handle state update
    if (message.type === 'state' && message.state) {
        session.lastState = message.state;

        // Forward state to all SDK sessions watching this bot
        for (const sdkSession of getSDKSessionsForBot(session.username)) {
            sendToSDK(sdkSession, {
                type: 'sdk_state',
                state: message.state
            });
        }
    }

    // Handle screenshot response from bot client
    if (message.type === 'screenshot_response' && (message as any).dataUrl) {
        // Forward screenshot to all connected controllers
        for (const [, controllerSession] of controllerSessions) {
            sendToController(controllerSession, {
                type: 'screenshot_response',
                username: session.username,
                dataUrl: (message as any).dataUrl
            });
        }
    }
}

function handleSDKMessage(ws: any, data: string) {
    let message: SDKMessage;
    try {
        message = JSON.parse(data);
    } catch {
        console.error('[Sync] Invalid JSON from SDK client');
        return;
    }

    // Handle SDK connection
    if (message.type === 'sdk_connect') {
        const sdkClientId = message.clientId || `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const targetUsername = message.username;

        const session: SDKSession = {
            ws,
            sdkClientId,
            targetUsername
        };

        sdkSessions.set(sdkClientId, session);
        wsToType.set(ws, { type: 'sdk', id: sdkClientId });

        console.log(`[Sync] SDK client connected: ${sdkClientId} -> bot: ${targetUsername}`);

        // Check if target bot is connected
        const botSession = botSessions.get(targetUsername);

        sendToSDK(session, {
            type: 'sdk_connected',
            success: true
        });

        // If bot is already connected and has state, send it immediately
        if (botSession?.lastState) {
            sendToSDK(session, {
                type: 'sdk_state',
                state: botSession.lastState
            });
        }
        return;
    }

    // Handle SDK action
    if (message.type === 'sdk_action') {
        const wsInfo = wsToType.get(ws);
        if (!wsInfo || wsInfo.type !== 'sdk') {
            console.error('[Sync] Received action from unknown SDK WebSocket');
            return;
        }

        const sdkSession = sdkSessions.get(wsInfo.id);
        if (!sdkSession) {
            console.error(`[Sync] No SDK session found: ${wsInfo.id}`);
            return;
        }

        const botSession = botSessions.get(message.username || sdkSession.targetUsername);
        if (!botSession || !botSession.ws) {
            sendToSDK(sdkSession, {
                type: 'sdk_error',
                actionId: message.actionId,
                error: 'Bot not connected'
            });
            return;
        }

        // Track the current action for result correlation
        botSession.currentActionId = message.actionId || null;

        // Forward action to bot
        sendToBot(botSession, {
            type: 'action',
            action: message.action,
            actionId: message.actionId
        });

        console.log(`[Sync] [${botSession.username}] SDK action: ${message.action?.type} (${message.actionId})`);
    }
}

// ============ WebSocket Handler ============

function handleControllerMessage(ws: any, data: string) {
    let message: any;
    try {
        message = JSON.parse(data);
    } catch {
        console.error('[Sync] Invalid JSON from controller');
        return;
    }

    // Handle controller connection
    if (message.type === 'controller_connect') {
        const clientId = message.clientId || `controller-${Date.now()}`;

        const session: ControllerSession = {
            ws,
            clientId
        };

        controllerSessions.set(clientId, session);
        wsToType.set(ws, { type: 'controller', id: clientId });

        console.log(`[Sync] Controller connected: ${clientId}`);
        return;
    }

    // Handle screenshot request from controller
    if (message.type === 'screenshot_request') {
        const { username } = message;
        if (!username) return;

        const botSession = botSessions.get(username);
        if (botSession?.ws) {
            // Forward screenshot request to the bot client
            sendToBot(botSession, {
                type: 'screenshot_request'
            } as any);
        }
        return;
    }
}

function handleMessage(ws: any, data: string) {
    // Try to determine message type
    let parsed: any;
    try {
        parsed = JSON.parse(data);
    } catch {
        console.error('[Sync] Invalid JSON');
        return;
    }

    // Route based on message type prefix
    if (parsed.type?.startsWith('sdk_')) {
        handleSDKMessage(ws, data);
    } else if (parsed.type?.startsWith('controller') || parsed.type === 'screenshot_request') {
        handleControllerMessage(ws, data);
    } else {
        handleBotMessage(ws, data);
    }
}

function handleClose(ws: any) {
    const wsInfo = wsToType.get(ws);
    if (!wsInfo) return;

    if (wsInfo.type === 'bot') {
        const session = botSessions.get(wsInfo.id);
        if (session) {
            console.log(`[Sync] Bot disconnected: ${session.clientId} (${session.username})`);
            session.ws = null;

            // Notify SDK sessions
            for (const sdkSession of getSDKSessionsForBot(session.username)) {
                sendToSDK(sdkSession, {
                    type: 'sdk_error',
                    error: 'Bot disconnected'
                });
            }
        }
    } else if (wsInfo.type === 'sdk') {
        const session = sdkSessions.get(wsInfo.id);
        if (session) {
            console.log(`[Sync] SDK disconnected: ${session.sdkClientId}`);
            sdkSessions.delete(wsInfo.id);
        }
    } else if (wsInfo.type === 'controller') {
        const session = controllerSessions.get(wsInfo.id);
        if (session) {
            console.log(`[Sync] Controller disconnected: ${session.clientId}`);
            controllerSessions.delete(wsInfo.id);
        }
    }

    wsToType.delete(ws);
}

// ============ Server Setup ============

console.log(`[Sync] Starting State Sync Service on port ${AGENT_PORT}...`);

const server = Bun.serve({
    port: AGENT_PORT,
    fetch(req, server) {
        const url = new URL(req.url);

        // Upgrade WebSocket connections
        if (req.headers.get('upgrade') === 'websocket') {
            const upgraded = server.upgrade(req);
            if (upgraded) return undefined;
            return new Response('WebSocket upgrade failed', { status: 400 });
        }

        // Serve status page
        if (url.pathname === '/' || url.pathname === '/status') {
            const bots: Record<string, any> = {};
            for (const [username, session] of botSessions) {
                bots[username] = {
                    connected: session.ws !== null,
                    clientId: session.clientId,
                    lastTick: session.lastState?.tick || 0,
                    inGame: session.lastState?.inGame || false,
                    player: session.lastState?.player?.name || null,
                    currentActionId: session.currentActionId
                };
            }

            const sdks: Record<string, any> = {};
            for (const [id, session] of sdkSessions) {
                sdks[id] = {
                    targetUsername: session.targetUsername
                };
            }

            return new Response(JSON.stringify({
                status: 'running',
                connectedBots: botSessions.size,
                connectedSDKs: sdkSessions.size,
                bots,
                sdks
            }, null, 2), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response('Not found', { status: 404 });
    },
    websocket: {
        open(ws: unknown) {
            console.log('[Sync] WebSocket connection opened');
        },
        message(ws: unknown, message: string | Buffer) {
            handleMessage(ws, message.toString());
        },
        close(ws: unknown) {
            handleClose(ws);
        }
    }
});

console.log(`[Sync] State Sync Service running at http://localhost:${AGENT_PORT}`);
console.log('[Sync] Pure WebSocket router - no file I/O');
console.log('[Sync] Waiting for bot and SDK clients to connect...');
