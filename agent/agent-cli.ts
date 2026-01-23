#!/usr/bin/env bun
// Agent CLI - Trigger agent runs from the command line for testing
// Usage: bun agent-cli.ts <bot-username> "<goal>"

const CONTROLLER_URL = process.env.CONTROLLER_URL || 'http://localhost:7781';

interface AgentStatus {
    bot: string;
    running: boolean;
    goal: string | null;
    logCount: number;
    agentServiceConnected: boolean;
}

interface LogEntry {
    timestamp: number;
    type: 'thinking' | 'action' | 'result' | 'error' | 'system' | 'user_message' | 'code';
    content: string;
}

// ANSI color codes
const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
};

function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function formatLogEntry(entry: LogEntry): string {
    const time = `${colors.dim}${formatTime(entry.timestamp)}${colors.reset}`;

    switch (entry.type) {
        case 'thinking':
            return `${time} ${colors.cyan}[THINKING]${colors.reset} ${entry.content}`;
        case 'action':
            return `${time} ${colors.yellow}[ACTION]${colors.reset} ${entry.content}`;
        case 'code':
            const codeLines = entry.content.split('\n');
            const codeFormatted = codeLines.map(l => `  ${colors.yellow}${l}${colors.reset}`).join('\n');
            return `${time} ${colors.yellow}[CODE]${colors.reset}\n${codeFormatted}`;
        case 'result':
            return `${time} ${colors.green}[RESULT]${colors.reset} ${entry.content}`;
        case 'error':
            return `${time} ${colors.red}[ERROR]${colors.reset} ${entry.content}`;
        case 'system':
            return `${time} ${colors.blue}[SYSTEM]${colors.reset} ${entry.content}`;
        case 'user_message':
            return `${time} ${colors.magenta}[USER]${colors.reset} ${entry.content}`;
        default:
            return `${time} [${entry.type}] ${entry.content}`;
    }
}

async function getStatus(botUsername: string): Promise<AgentStatus | null> {
    try {
        const response = await fetch(`${CONTROLLER_URL}/status?bot=${botUsername}`);
        return await response.json() as AgentStatus;
    } catch (e) {
        return null;
    }
}

async function getLog(botUsername: string): Promise<LogEntry[]> {
    try {
        const response = await fetch(`${CONTROLLER_URL}/log?bot=${botUsername}`);
        return await response.json() as LogEntry[];
    } catch (e) {
        return [];
    }
}

async function startAgent(botUsername: string, goal: string): Promise<boolean> {
    try {
        const response = await fetch(`${CONTROLLER_URL}/start?bot=${botUsername}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ goal })
        });
        const result = await response.json() as { ok: boolean };
        return result.ok;
    } catch (e) {
        return false;
    }
}

async function stopAgent(botUsername: string): Promise<boolean> {
    try {
        const response = await fetch(`${CONTROLLER_URL}/stop?bot=${botUsername}`, {
            method: 'POST'
        });
        const result = await response.json() as { ok: boolean };
        return result.ok;
    } catch (e) {
        return false;
    }
}

async function streamLogs(botUsername: string, onComplete?: () => void): Promise<void> {
    let lastLogCount = 0;
    let wasRunning = true;
    let checkCount = 0;
    const maxIdleChecks = 10;  // Stop after 10 checks of no activity (~10 seconds)

    console.log(`${colors.dim}Streaming logs for ${botUsername}...${colors.reset}`);
    console.log(`${colors.dim}Press Ctrl+C to stop${colors.reset}\n`);

    while (true) {
        const status = await getStatus(botUsername);
        if (!status) {
            console.log(`${colors.red}Failed to get status - controller not available?${colors.reset}`);
            break;
        }

        const log = await getLog(botUsername);

        // Print new entries
        if (log.length > lastLogCount) {
            for (let i = lastLogCount; i < log.length; i++) {
                console.log(formatLogEntry(log[i]));
            }
            lastLogCount = log.length;
            checkCount = 0;  // Reset idle counter on activity
        }

        // Check if agent stopped
        if (wasRunning && !status.running) {
            console.log(`\n${colors.green}${colors.bold}Agent completed!${colors.reset}`);
            console.log(`${colors.dim}Logs: ${log.length} entries${colors.reset}`);
            console.log(`${colors.dim}Run recorded to ./runs/ folder${colors.reset}`);
            onComplete?.();
            break;
        }

        // Check for idle timeout when not running
        if (!status.running) {
            checkCount++;
            if (checkCount >= maxIdleChecks) {
                console.log(`\n${colors.yellow}Agent not running and no activity. Exiting.${colors.reset}`);
                break;
            }
        }

        wasRunning = status.running;
        await Bun.sleep(1000);
    }
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        console.log(`
${colors.bold}Agent CLI${colors.reset} - Trigger agent runs from the command line

${colors.bold}Usage:${colors.reset}
  bun agent-cli.ts <command> [options]

${colors.bold}Commands:${colors.reset}
  start <bot> "<goal>"   Start agent for bot with given goal
  stop <bot>             Stop running agent
  status [bot]           Get status (all bots if no bot specified)
  logs <bot>             Stream logs for bot
  run <bot> "<goal>"     Start agent and stream logs until completion

${colors.bold}Examples:${colors.reset}
  bun agent-cli.ts start shopper1 "Walk to the bank and open it"
  bun agent-cli.ts run shopper1 "Complete the tutorial"
  bun agent-cli.ts status shopper1
  bun agent-cli.ts logs shopper1
  bun agent-cli.ts stop shopper1

${colors.bold}Environment:${colors.reset}
  CONTROLLER_URL   Controller URL (default: http://localhost:7781)
`);
        return;
    }

    const command = args[0];

    switch (command) {
        case 'start': {
            const bot = args[1];
            const goal = args[2];
            if (!bot || !goal) {
                console.log(`${colors.red}Usage: start <bot> "<goal>"${colors.reset}`);
                process.exit(1);
            }
            console.log(`${colors.cyan}Starting agent for ${bot}...${colors.reset}`);
            console.log(`${colors.dim}Goal: ${goal}${colors.reset}\n`);
            const ok = await startAgent(bot, goal);
            if (ok) {
                console.log(`${colors.green}Agent started!${colors.reset}`);
                console.log(`${colors.dim}Run: bun agent-cli.ts logs ${bot}  to stream logs${colors.reset}`);
            } else {
                console.log(`${colors.red}Failed to start agent. Is the controller running?${colors.reset}`);
                process.exit(1);
            }
            break;
        }

        case 'stop': {
            const bot = args[1];
            if (!bot) {
                console.log(`${colors.red}Usage: stop <bot>${colors.reset}`);
                process.exit(1);
            }
            console.log(`${colors.cyan}Stopping agent for ${bot}...${colors.reset}`);
            const ok = await stopAgent(bot);
            if (ok) {
                console.log(`${colors.green}Agent stopped!${colors.reset}`);
            } else {
                console.log(`${colors.red}Failed to stop agent${colors.reset}`);
                process.exit(1);
            }
            break;
        }

        case 'status': {
            const bot = args[1] || 'all';
            const response = await fetch(`${CONTROLLER_URL}/status?bot=${bot}`);
            const status = await response.json();
            console.log(JSON.stringify(status, null, 2));
            break;
        }

        case 'logs': {
            const bot = args[1];
            if (!bot) {
                console.log(`${colors.red}Usage: logs <bot>${colors.reset}`);
                process.exit(1);
            }
            await streamLogs(bot);
            break;
        }

        case 'run': {
            const bot = args[1];
            const goal = args[2];
            if (!bot || !goal) {
                console.log(`${colors.red}Usage: run <bot> "<goal>"${colors.reset}`);
                process.exit(1);
            }

            // Check if bot is already running
            const status = await getStatus(bot);
            if (status?.running) {
                console.log(`${colors.yellow}Agent already running for ${bot}${colors.reset}`);
                console.log(`${colors.dim}Streaming existing session...${colors.reset}\n`);
            } else {
                console.log(`${colors.cyan}Starting agent for ${bot}...${colors.reset}`);
                console.log(`${colors.dim}Goal: ${goal}${colors.reset}\n`);
                const ok = await startAgent(bot, goal);
                if (!ok) {
                    console.log(`${colors.red}Failed to start agent. Is the controller running?${colors.reset}`);
                    process.exit(1);
                }
                // Give it a moment to start
                await Bun.sleep(500);
            }

            await streamLogs(bot);
            break;
        }

        default:
            console.log(`${colors.red}Unknown command: ${command}${colors.reset}`);
            console.log(`${colors.dim}Run: bun agent-cli.ts --help  for usage${colors.reset}`);
            process.exit(1);
    }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    console.log(`\n${colors.dim}Interrupted.${colors.reset}`);
    process.exit(0);
});

main().catch(e => {
    console.error(`${colors.red}Error: ${e.message}${colors.reset}`);
    process.exit(1);
});
