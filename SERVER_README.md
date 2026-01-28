# RS-SDK-Demo Server

Demo Production server running on Fly.io with game server, web client, and bot SDK gateway.

## Endpoints

### Web & Game

| Endpoint | Description |
|----------|-------------|
| `https://rs-sdk-demo.fly.dev/` | Web client (play in browser) |
| `https://rs-sdk-demo.fly.dev/rs2.cgi` | Classic web client URL |
| `https://rs-sdk-demo.fly.dev/bot` | Bot view client |
| `rs-sdk-demo.fly.dev:43594` | Game server (TCP) for Java client |

### Bot SDK / Gateway

| Endpoint | Description |
|----------|-------------|
| `wss://rs-sdk-demo.fly.dev/agent` | Bot/SDK WebSocket connection |
| `wss://rs-sdk-demo.fly.dev/agent?bot=<name>` | Multi-bot SDK connection |
| `wss://rs-sdk-demo.fly.dev/agent-controller` | UI WebSocket (agent control panel) |
| `wss://rs-sdk-demo.fly.dev/agent-controller?bot=<name>` | Multi-bot UI connection |
| `https://rs-sdk-demo.fly.dev/gateway/status` | Gateway status (JSON) |

### APIs

| Endpoint | Description |
|----------|-------------|
| `GET /api/findPath?srcX=&srcZ=&destX=&destZ=&level=` | Server-side pathfinding |
| `POST /api/screenshot` | Save screenshot (base64 PNG) |

### Logs & Runs

| Endpoint | Description |
|----------|-------------|
| `/runs` | Agent test runs viewer |
| `/script_runs` | Script execution runs |
| `/screenshots` | Screenshot gallery |

## SDK Connection Example

```typescript
import { GameClient } from 'rs-agent-sdk';

const client = new GameClient({
  gatewayUrl: 'wss://rs-sdk-demo.fly.dev/agent',
  webPort: 443,
  webHost: 'rs-sdk-demo.fly.dev',
  useHttps: true
});

await client.connect('mybot');
```

## Multi-Bot Support

Use the `?bot=<username>` query parameter to run multiple bots:

```typescript
// Bot 1
const bot1 = new GameClient({ gatewayUrl: 'wss://rs-sdk-demo.fly.dev/agent?bot=bot1' });

// Bot 2
const bot2 = new GameClient({ gatewayUrl: 'wss://rs-sdk-demo.fly.dev/agent?bot=bot2' });
```

## Deployment

```bash
# Deploy changes
fly deploy -a rs-sdk-demo

# View logs
fly logs -a rs-sdk-demo

# SSH into machine
fly ssh console -a rs-sdk-demo

# Check status
curl https://rs-sdk-demo.fly.dev/gateway/status
```
