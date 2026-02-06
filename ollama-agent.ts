#!/usr/bin/env bun
/**
 * Ollama Agent for RS-SDK
 *
 * Interactive CLI agent that bridges a local Ollama model to the MCP server,
 * enabling LLM-driven bot control without Anthropic's API.
 *
 * Supports two modes:
 * - Native tool calling (for models that support Ollama's `tools` parameter)
 * - Prompt-based tool calling (for models like gemma3 that don't)
 *
 * Usage:
 *   bun ollama-agent.ts                     # defaults to gemma3:12b
 *   bun ollama-agent.ts --model llama3.1:8b  # use a different model
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as readline from 'node:readline';

// ── Ollama API Types ────────────────────────────────────────────────────────

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
}

interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// ── MCP Client ──────────────────────────────────────────────────────────────

async function createMcpClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', 'mcp/server.ts'],
  });

  const client = new Client(
    { name: 'ollama-agent', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  return client;
}

// ── Tool Discovery ──────────────────────────────────────────────────────────

async function discoverTools(client: Client): Promise<OllamaTool[]> {
  const { tools } = await client.listTools();

  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }));
}

// ── System Prompt ───────────────────────────────────────────────────────────

const VALID_TOOL_NAMES = ['execute_code', 'list_bots', 'disconnect_bot'];

function buildSystemPrompt(tools: OllamaTool[], useNativeTools: boolean): string {
  const toolCallSection = useNativeTools
    ? ''
    : `

# Tool Calling Format

You have 3 tools: execute_code, list_bots, disconnect_bot.

To call a tool, write TOOL_CALL on its own line, then a JSON object, then END_TOOL_CALL. Example:

TOOL_CALL
{"name": "list_bots", "arguments": {}}
END_TOOL_CALL

TOOL_CALL
{"name": "execute_code", "arguments": {"bot_name": "mybot", "code": "return sdk.getState();"}}
END_TOOL_CALL

Rules:
- The JSON must have "name" (one of: execute_code, list_bots, disconnect_bot) and "arguments" (object).
- Only ONE tool call per response.
- Put all code on a single line. Use \\n for newlines within code strings.
- The bot auto-connects on first execute_code call. No need to call connect().
- After seeing the tool result, respond to the user OR make another tool call.`;

  return `You are a game bot controller. You execute TypeScript code on game bots via tools.

# execute_code Tool

The code runs in an async context with two globals:
- bot: High-level actions (await bot.chopTree(), await bot.walkTo(x,z), etc.)
- sdk: Low-level methods (sdk.getState(), sdk.sendDropItem(slot), etc.)

IMPORTANT: bot and sdk are SEPARATE objects. Don't mix them up.
- bot.chopTree() ✓   sdk.chopTree() ✗
- sdk.sendDropItem() ✓   bot.sendDropItem() ✗

## bot methods (high-level, await these):
await bot.chopTree(target?) - Chop a tree. target is from sdk.findNearbyLoc(), NOT findNearbyNpc()!
await bot.walkTo(x, z) - Walk to coordinates with pathfinding
await bot.attackNpc(target) - Attack an NPC. target is from sdk.findNearbyNpc()
await bot.talkTo(target) - Talk to an NPC. target is from sdk.findNearbyNpc()
await bot.openBank() / bot.closeBank() / bot.depositItem(target, amount) / bot.withdrawItem(slot, amount)
await bot.openShop(target) / bot.buyFromShop(target, amount) / bot.sellToShop(target, amount)
await bot.equipItem(target) / bot.unequipItem(target) / bot.eatFood(target)
await bot.pickupItem(target) - Pick up ground item
await bot.openDoor(target?) - Open a door/gate
await bot.fletchLogs(product?) / bot.burnLogs(target?) / bot.smithAtAnvil(product)
await bot.dismissBlockingUI() - ALWAYS call in loops to dismiss level-up dialogs
await bot.waitForIdle()

## sdk methods (low-level):
sdk.getState() - Returns full world state object
sdk.getInventory() - Returns array of 28 slots, each null or {slot, id, name, amount}
sdk.findInventoryItem(/pattern/i) - Returns ONE matching item {slot, id, name, amount} or null (NOT an array!)
sdk.findNearbyLoc(/pattern/i) - Find a LOCATION (trees, rocks, banks, doors, anvils). Returns one or null
sdk.findNearbyNpc(/pattern/i) - Find an NPC (goblins, shopkeepers, bankers). Returns one or null
IMPORTANT: Trees are LOCATIONS, not NPCs! Use findNearbyLoc for trees/rocks/objects.
sdk.getSkill(name) / sdk.getSkillXp(name)
await sdk.sendDropItem(slot) - Drop an inventory item by SLOT NUMBER
await sdk.sendUseItem(slot, option) - Use an inventory item
await sdk.sendWalk(x, z)
await sdk.sendInteractNpc(index, option)
await sdk.sendInteractLoc(x, z, id, option)
await sdk.sendClickDialog(option)

## Common patterns:
// Check state
return sdk.getState();

// Chop specific tree type (oak, willow, etc.) — trees are LOCATIONS!
const oak = sdk.findNearbyLoc(/^oak$/i);
if (oak) await bot.chopTree(oak);

// Drop specific logs
const inv = sdk.getInventory();
for (const item of inv) { if (item?.name?.match(/oak logs?/i)) await sdk.sendDropItem(item.slot); }

// Woodcutting loop with auto-drop (ALWAYS use a time limit!)
const end = Date.now() + 120000;
while (Date.now() < end) {
  await bot.dismissBlockingUI();
  const tree = sdk.findNearbyLoc(/^oak$/i);
  if (tree) await bot.chopTree(tree);
  const inv = sdk.getInventory();
  if (!inv.find(s => s === null)) { for (const it of inv) { if (it?.name?.match(/oak logs?/i)) await sdk.sendDropItem(it.slot); } }
}
${toolCallSection}`;
}

// ── Ollama API ──────────────────────────────────────────────────────────────

const OLLAMA_BASE = 'http://localhost:11434';

async function checkOllamaHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

async function probeNativeToolSupport(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'test',
              description: 'test',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        stream: false,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      if (text.includes('does not support tools')) return false;
    }
    return res.ok;
  } catch {
    return false;
  }
}

async function callOllama(
  model: string,
  messages: OllamaMessage[],
  tools: OllamaTool[] | undefined
): Promise<OllamaChatResponse> {
  const body: any = {
    model,
    messages,
    stream: false,
  };
  if (tools) {
    body.tools = tools;
  }

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama API error (${res.status}): ${text}`);
  }

  return (await res.json()) as OllamaChatResponse;
}

// ── Prompt-Based Tool Call Parsing ──────────────────────────────────────────

function tryParseToolJson(jsonStr: string): ParsedToolCall | null {
  try {
    const parsed = JSON.parse(jsonStr);
    if (
      parsed.name &&
      typeof parsed.name === 'string' &&
      VALID_TOOL_NAMES.includes(parsed.name)
    ) {
      return {
        name: parsed.name,
        arguments: parsed.arguments ?? {},
      };
    }
  } catch {
    // not valid JSON
  }
  return null;
}

function parseToolCallsFromText(text: string): { textBefore: string; toolCall: ParsedToolCall | null } {
  // Strategy 1: TOOL_CALL ... END_TOOL_CALL markers
  const markerRegex = /TOOL_CALL\s*\n?([\s\S]*?)\n?\s*END_TOOL_CALL/;
  const markerMatch = text.match(markerRegex);
  if (markerMatch) {
    const tc = tryParseToolJson(markerMatch[1].trim());
    if (tc) {
      return { textBefore: text.slice(0, markerMatch.index).trim(), toolCall: tc };
    }
  }

  // Strategy 2: ```tool_call code blocks (with or without closing ```)
  const codeBlockPatterns = [
    /```tool_call\s*\n?([\s\S]*?)\n?\s*```/,
    /```tool_call\s*\n?([\s\S]+)$/,  // no closing backticks
  ];
  for (const regex of codeBlockPatterns) {
    const match = text.match(regex);
    if (match) {
      const tc = tryParseToolJson(match[1].trim());
      if (tc) {
        return { textBefore: text.slice(0, match.index).trim(), toolCall: tc };
      }
    }
  }

  // Strategy 3: ```json or bare ``` code blocks
  const jsonBlockPatterns = [
    /```json\s*\n?([\s\S]*?)\n?\s*```/,
    /```\s*\n?([\s\S]*?)\n?\s*```/,
  ];
  for (const regex of jsonBlockPatterns) {
    const match = text.match(regex);
    if (match) {
      const tc = tryParseToolJson(match[1].trim());
      if (tc) {
        return { textBefore: text.slice(0, match.index).trim(), toolCall: tc };
      }
    }
  }

  // Strategy 4: <tool_call> XML tags
  const xmlRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/;
  const xmlMatch = text.match(xmlRegex);
  if (xmlMatch) {
    const tc = tryParseToolJson(xmlMatch[1].trim());
    if (tc) {
      return { textBefore: text.slice(0, xmlMatch.index).trim(), toolCall: tc };
    }
  }

  // Strategy 5: Find JSON objects containing a valid tool name anywhere in text
  // Use a balanced-brace extraction approach
  const toolNameRegex = /"name"\s*:\s*"(execute_code|list_bots|disconnect_bot)"/g;
  let nameMatch;
  while ((nameMatch = toolNameRegex.exec(text)) !== null) {
    // Walk backward from match to find opening {
    let start = nameMatch.index;
    while (start > 0 && text[start] !== '{') start--;
    if (text[start] !== '{') continue;

    // Walk forward with brace counting to find the balanced closing }
    let depth = 0;
    let end = start;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}') {
        depth--;
        if (depth === 0) { end++; break; }
      }
    }
    if (depth !== 0) continue;

    const candidate = text.slice(start, end);
    const tc = tryParseToolJson(candidate);
    if (tc) {
      return { textBefore: text.slice(0, start).trim(), toolCall: tc };
    }
  }

  // Nothing found — log for debugging
  if (text.includes('execute_code') || text.includes('list_bots') || text.includes('disconnect_bot')) {
    console.error(`  [debug] Tool name found in text but could not parse tool call. Response preview:`);
    console.error(`  [debug] ${text.slice(-300)}`);
  }

  return { textBefore: text, toolCall: null };
}

// ── Tool Execution ──────────────────────────────────────────────────────────

const MAX_TOOL_RESULT_LENGTH = 4000;

const TOOL_TIMEOUT_MS = 5 * 60_000; // 5 minutes — long enough for game loops

async function executeTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS }
    );

    const text = result.content
      .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');

    if (text.length > MAX_TOOL_RESULT_LENGTH) {
      return text.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n... (truncated)';
    }
    return text;
  } catch (err: any) {
    if (err.message?.includes('timed out') || err.message?.includes('Timeout')) {
      return 'The script ran longer than expected but the bot is still running. Check state with sdk.getState() to see what happened.';
    }
    return `Tool error: ${err.message}`;
  }
}

// ── Agent Loop ──────────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 10;

async function agentLoop(
  client: Client,
  model: string,
  tools: OllamaTool[],
  systemPrompt: string,
  useNativeTools: boolean
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  console.log('\nType a message to chat. Commands: /clear, /quit\n');

  while (true) {
    const input = await prompt('You> ');
    const trimmed = input.trim();

    if (!trimmed) continue;

    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log('Goodbye!');
      rl.close();
      return;
    }

    if (trimmed === '/clear') {
      messages.length = 1; // keep system prompt
      console.log('Conversation cleared.\n');
      continue;
    }

    messages.push({ role: 'user', content: trimmed });

    let rounds = 0;
    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      let response: OllamaChatResponse;
      try {
        response = await callOllama(model, messages, useNativeTools ? tools : undefined);
      } catch (err: any) {
        console.error(`\nError: ${err.message}\n`);
        if (rounds === 1) messages.pop();
        break;
      }

      const assistantMsg = response.message;
      const rawContent = assistantMsg.content || '';

      if (useNativeTools) {
        // ── Native tool calling mode ──
        if (rawContent) {
          console.log(`\nAssistant> ${rawContent}`);
        }

        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
          messages.push({ role: 'assistant', content: rawContent });
          console.log();
          break;
        }

        messages.push({
          role: 'assistant',
          content: rawContent,
          tool_calls: assistantMsg.tool_calls,
        });

        for (const toolCall of assistantMsg.tool_calls) {
          const { name, arguments: args } = toolCall.function;
          console.log(`\n  [tool] ${name}(${JSON.stringify(args)})`);

          const result = await executeTool(client, name, args);
          console.log(`  [result] ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`);

          messages.push({ role: 'tool', content: result });
        }
      } else {
        // ── Prompt-based tool calling mode ──
        const { textBefore, toolCall } = parseToolCallsFromText(rawContent);

        if (textBefore) {
          console.log(`\nAssistant> ${textBefore}`);
        }

        if (!toolCall) {
          // Check if the model started a tool call but didn't finish it
          const incompleteMarkers = ['TOOL_CALL', '```tool_call', '```json', '<tool_call>'];
          const looksIncomplete = incompleteMarkers.some((m) => rawContent.trimEnd().endsWith(m) || rawContent.includes(m));

          if (looksIncomplete && rounds < MAX_TOOL_ROUNDS) {
            console.log('\n  [retry] Incomplete tool call detected, re-prompting...');
            messages.push({ role: 'assistant', content: textBefore || '' });
            messages.push({
              role: 'user',
              content: 'Your tool call was incomplete. Please output the complete tool call with valid JSON. Remember the format:\nTOOL_CALL\n{"name": "execute_code", "arguments": {"bot_name": "mybot", "code": "..."}}\nEND_TOOL_CALL',
            });
            continue;
          }

          messages.push({ role: 'assistant', content: rawContent });
          console.log();
          break;
        }

        // Store assistant message without the tool call markup for cleaner history
        messages.push({ role: 'assistant', content: textBefore || `Calling ${toolCall.name}...` });

        console.log(`\n  [tool] ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`);
        const result = await executeTool(client, toolCall.name, toolCall.arguments);
        console.log(`  [result] ${result.slice(0, 500)}${result.length > 500 ? '...' : ''}`);

        // Feed result back as user message with clear framing and format reminder
        messages.push({
          role: 'user',
          content: `[Tool result for ${toolCall.name}]:\n${result}\n\nRespond to the user based on this result. To make another tool call, use the TOOL_CALL format.`,
        });
      }
    }

    if (rounds >= MAX_TOOL_ROUNDS) {
      console.log('\n(Reached tool-call limit, stopping.)\n');
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let model = 'gemma3:12b';
  const modelIdx = args.indexOf('--model');
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    model = args[modelIdx + 1];
  }

  console.log(`Ollama Agent — model: ${model}`);
  console.log('Checking Ollama...');

  const healthy = await checkOllamaHealth();
  if (!healthy) {
    console.error('Error: Cannot reach Ollama at http://localhost:11434');
    console.error('Make sure Ollama is running: ollama serve');
    process.exit(1);
  }
  console.log('Ollama is running.');

  console.log('Checking tool support...');
  const useNativeTools = await probeNativeToolSupport(model);
  console.log(
    useNativeTools
      ? 'Using native tool calling.'
      : 'Model does not support native tools — using prompt-based tool calling.'
  );

  console.log('Starting MCP server...');
  const client = await createMcpClient();
  console.log('MCP server connected.');

  const tools = await discoverTools(client);
  console.log(`Discovered ${tools.length} tools: ${tools.map((t) => t.function.name).join(', ')}`);

  const systemPrompt = buildSystemPrompt(tools, useNativeTools);

  console.log('\nOllama Agent ready!');

  const cleanup = async () => {
    console.log('\nShutting down...');
    try {
      await client.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    await agentLoop(client, model, tools, systemPrompt, useNativeTools);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
