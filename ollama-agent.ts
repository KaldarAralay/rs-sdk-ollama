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
- After seeing the tool result, respond to the user OR make another tool call.
- Be concise. Don't show code blocks to the user — just make the tool call directly.
- Double-check your brace count: every { needs a matching } in the code string.`;

  return `You are a game bot controller. You execute TypeScript code on game bots via tools.

# execute_code Tool

The code runs in an async context with two globals:
- bot: High-level actions (await bot.chopTree(), await bot.walkTo(x,z), etc.)
- sdk: Low-level methods (sdk.getState(), sdk.sendDropItem(slot), etc.)

IMPORTANT: bot and sdk are SEPARATE objects. Don't mix them up.
- bot.chopTree() ✓   sdk.chopTree() ✗
- sdk.sendDropItem() ✓   bot.sendDropItem() ✗

CRITICAL LOOP RULES:
1. ALWAYS add "await new Promise(r => setTimeout(r, 1000));" after EVERY action in a loop (success or failure)
2. ALWAYS re-find NPCs/items each iteration — NEVER reuse references from a previous iteration (NPCs die, items get picked up)
3. If an action fails, wait and continue to the next iteration — do NOT retry the same action immediately
4. BRACE COUNTING: A while loop has exactly ONE closing }. Do NOT add extra braces. Count carefully: while (...) { ... } — that is ONE { and ONE }

## bot methods (high-level, await these):
// Movement
await bot.walkTo(x, z, tolerance?) - Walk to coordinates with pathfinding, auto-opening doors
await bot.waitForIdle(timeout?) - Wait for player to stop moving
// Combat & Equipment
await bot.attackNpc(target, timeout?) - Attack an NPC (ONLY sends Attack option). target from sdk.findNearbyNpc()
await bot.castSpellOnNpc(target, spellComponent, timeout?) - Cast a combat spell on an NPC
await bot.equipItem(target) - Equip an item. target is string or regex
await bot.unequipItem(target) - Unequip an item to inventory
await bot.findEquippedItem(pattern) - Find equipped item by name pattern
await bot.eatFood(target) - Eat food to restore HP
// Woodcutting, Firemaking, Crafting
await bot.chopTree(target?) - Chop a tree. target from sdk.findNearbyLoc(), NOT findNearbyNpc()!
await bot.burnLogs(target?) - Burn logs using tinderbox
await bot.fletchLogs(product?) - Fletch logs into bows/arrows with knife
await bot.smithAtAnvil(product, options?) - Smith bars at anvil
await bot.craftLeather(product?) - Craft leather with needle and thread
// Items
await bot.pickupItem(target) - Pick up ground item. target from sdk.findGroundItem()
await bot.useItemOnLoc(item, loc, options?) - Use inventory item on a location (cooking, smelting, etc.)
// NPC Interaction
await bot.talkTo(target) - Talk to NPC, wait for dialog. target from sdk.findNearbyNpc()
await bot.openDoor(target?) - Open a door/gate
// Shopping
await bot.openShop(target) / bot.closeShop() / bot.buyFromShop(target, amount) / bot.sellToShop(target, amount)
// Banking
await bot.openBank() / bot.closeBank() / bot.depositItem(target, amount) / bot.withdrawItem(slot, amount)
// UI & Dialog
await bot.dismissBlockingUI() - ALWAYS call in loops to dismiss level-up dialogs
await bot.skipTutorial() - Skip the tutorial (call this if character is in tutorial area)
await bot.waitForDialogClose(timeout?) - Wait for dialog to close
// Condition Waiting
await bot.waitForSkillLevel(skillName, targetLevel, timeout?) - Wait until a skill reaches target level
await bot.waitForInventoryItem(pattern, timeout?) - Wait until item appears in inventory

## sdk methods (low-level):
// State Access
sdk.getState() - Returns full world state (see State Shape below)
sdk.getInventory() - Returns array of 28 slots, each null or {slot, id, name, count, optionsWithIndex}
sdk.findInventoryItem(/pattern/i) - Returns ONE matching item or null (NOT an array!)
sdk.getInventoryItem(slot) - Get inventory item by slot number
sdk.findNearbyLoc(/pattern/i) - Find a LOCATION (trees, rocks, banks, doors, anvils). Returns one or null
sdk.findNearbyNpc(/pattern/i) - Find an NPC (goblins, shopkeepers, bankers). Returns one or null
sdk.getNearbyNpc(index) - Get NPC by index number
sdk.getNearbyLoc(x, z, id) - Get location by coordinates and ID
sdk.findGroundItem(/pattern/i) - Find a ground item (bones, coins, drops). Returns one or null
sdk.findEquipmentItem(/pattern/i) - Find equipped item by name pattern
sdk.getEquipmentItem(slot) - Get equipment item by slot number
sdk.findBankItem(/pattern/i) - Find bank item by name (bank must be open)
sdk.getBankItem(slot) - Get bank item by slot (bank must be open)
sdk.getSkill(name) - Returns {name, level, baseLevel, experience}. Use for health: sdk.getSkill('hitpoints').level
sdk.getSkillXp(name) - Get XP for a skill
IMPORTANT: Trees are LOCATIONS, not NPCs! Use findNearbyLoc for trees/rocks/objects.
// On-Demand Scanning (extended radius search)
await sdk.scanNearbyLocs(radius?) - Scan for locations with custom radius
await sdk.scanGroundItems(radius?) - Scan for ground items
await sdk.scanFindNearbyLoc(/pattern/i, radius?) - Find location with extended scan
await sdk.scanFindGroundItem(/pattern/i, radius?) - Find ground item with extended scan
// Raw Actions
await sdk.sendWalk(x, z, running?) - Walk to coordinates
await sdk.sendInteractNpc(index, option) - Interact with NPC by index and menu option
await sdk.sendInteractLoc(x, z, locId, option) - Interact with a location
await sdk.sendTalkToNpc(npcIndex) - Talk to NPC by index
await sdk.sendPickup(x, z, itemId) - Pick up ground item by coords and ID
await sdk.sendUseItem(slot, option) - Use inventory item. Find option from item.optionsWithIndex!
await sdk.sendUseEquipmentItem(slot, option) - Use an equipped item (remove, operate)
await sdk.sendDropItem(slot) - Drop inventory item by slot
await sdk.sendUseItemOnItem(sourceSlot, targetSlot) - Use one item on another (e.g. knife on logs)
await sdk.sendUseItemOnLoc(itemSlot, x, z, locId) - Use item on a location (e.g. ore on furnace)
await sdk.sendClickDialog(option) - Click dialog option by index
await sdk.sendClickComponent(componentId) - Click a UI component/button
await sdk.sendClickComponentWithOption(componentId, optionIndex) - Click component with specific option
await sdk.sendClickInterfaceOption(optionIndex) - Click interface option
await sdk.sendShopBuy(slot, amount) / sdk.sendShopSell(slot, amount) - Buy/sell by slot
await sdk.sendBankDeposit(slot, amount) / sdk.sendBankWithdraw(slot, amount) - Bank operations
await sdk.sendSetCombatStyle(style) - Set combat style (0-3)
await sdk.sendSpellOnNpc(npcIndex, spellComponent) - Cast spell on NPC
await sdk.sendSpellOnItem(slot, spellComponent) - Cast spell on item
await sdk.sendSay(message) - Send chat message
await sdk.sendWait(ticks) - Wait for game ticks (~420ms each)
await sdk.sendSetTab(tabIndex) - Switch UI tab
await sdk.sendScreenshot(timeout?) - Request screenshot
await sdk.sendFindPath(destX, destZ, maxWaypoints?) - Find path to destination
// Waiting
await sdk.waitForStateChange(timeout?) - Wait for next state update
await sdk.waitForTicks(ticks) - Wait for specific number of server ticks

## NPC menu options (Pickpocket, Talk-to, Attack, etc.)
NPCs have an optionsWithIndex array listing all right-click options. Use this to pick actions other than Attack:
const npc = sdk.findNearbyNpc(/^man$/i);
const opt = npc.optionsWithIndex.find(o => /pickpocket/i.test(o.text));
await sdk.sendInteractNpc(npc.index, opt.opIndex);
IMPORTANT: bot.attackNpc() ONLY sends Attack. For Pickpocket or other options, use sdk.sendInteractNpc().

## Inventory item options (Bury, Eat, Equip, Drop, etc.)
Inventory items ALSO have optionsWithIndex, just like NPCs. NEVER hardcode slot numbers or option indexes!
// Bury bones example:
const bones = sdk.findInventoryItem(/bones/i);
if (bones) {
  const buryOpt = bones.optionsWithIndex.find(o => /bury/i.test(o.text));
  if (buryOpt) await sdk.sendUseItem(bones.slot, buryOpt.opIndex);
}
// Eat food example:
const food = sdk.findInventoryItem(/kebab|shrimp|bread/i);
if (food) {
  const eatOpt = food.optionsWithIndex.find(o => /eat/i.test(o.text));
  if (eatOpt) await sdk.sendUseItem(food.slot, eatOpt.opIndex);
}
IMPORTANT: Always use findInventoryItem() to get the actual slot, and optionsWithIndex to get the right option!

## State Shape (sdk.getState() returns):
state.player.worldX, state.player.worldZ - Current position
state.player.combat.inCombat - true if in combat
state.player.combat.targetIndex - NPC index we're fighting (-1 if none)
state.player.animId - Current animation (-1 = idle)
state.skills[] - Array of {name, level, baseLevel, experience}
state.inventory[] - Array of items with {slot, id, name, count, optionsWithIndex}
state.equipment[] - Equipped items
state.nearbyNpcs[] - NPCs with {index, name, optionsWithIndex, ...}
state.nearbyLocs[] - Locations/objects
state.groundItems[] - Items on the ground
state.gameMessages[] - Recent game messages {text}
state.dialog.isOpen - Whether a dialog is open
state.shop.isOpen / state.bank.isOpen - Shop/bank open
state.combatStyle - {currentStyle, weaponName, styles[]}

## Health monitoring
Check HP: sdk.getSkill('hitpoints') returns {level (current), baseLevel (max)}
NOT sdk.getState().character.health — that does NOT exist!
Check game messages: sdk.getState().gameMessages — array of {text} for stun/damage/success messages
Check if in combat: sdk.getState().player.combat.inCombat (boolean)

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

// Pickpocketing loop with health monitoring and stun handling
const end = Date.now() + 120000;
while (Date.now() < end) {
  await bot.dismissBlockingUI();
  const hp = sdk.getSkill('hitpoints');
  if (hp && hp.level <= 3) { console.log('HP low, waiting...'); await new Promise(r => setTimeout(r, 10000)); continue; }
  const man = sdk.getState()?.nearbyNpcs.find(n => /^man$/i.test(n.name));
  if (!man) { await bot.walkTo(3222, 3218); continue; }
  const opt = man.optionsWithIndex.find(o => /pickpocket/i.test(o.text));
  if (opt) { await sdk.sendInteractNpc(man.index, opt.opIndex); await new Promise(r => setTimeout(r, 1000)); }
  const stunned = (sdk.getState()?.gameMessages ?? []).some(m => /stunned/i.test(m.text));
  if (stunned) { await new Promise(r => setTimeout(r, 5000)); }
}

// Combat loop with looting and burying bones
const end = Date.now() + 120000;
while (Date.now() < end) {
  await bot.dismissBlockingUI();
  const hp = sdk.getSkill('hitpoints');
  if (hp && hp.level <= 5) { console.log('HP low, waiting...'); await new Promise(r => setTimeout(r, 60000)); continue; }
  // Loot ground items first (bones, coins)
  const bones = sdk.findGroundItem(/bones/i);
  if (bones) { await bot.pickupItem(bones); await new Promise(r => setTimeout(r, 1000)); continue; }
  const coins = sdk.findGroundItem(/coins/i);
  if (coins) { await bot.pickupItem(coins); await new Promise(r => setTimeout(r, 1000)); continue; }
  // Bury any bones in inventory
  const invBones = sdk.findInventoryItem(/bones/i);
  if (invBones) { const opt = invBones.optionsWithIndex.find(o => /bury/i.test(o.text)); if (opt) await sdk.sendUseItem(invBones.slot, opt.opIndex); await new Promise(r => setTimeout(r, 1000)); continue; }
  // Attack a goblin
  const goblin = sdk.findNearbyNpc(/^goblin$/i);
  if (goblin) { await bot.attackNpc(goblin); await new Promise(r => setTimeout(r, 1000)); }
  await new Promise(r => setTimeout(r, 1000));
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

function tryParseAndValidate(jsonStr: string): ParsedToolCall | null {
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

function tryParseToolJson(jsonStr: string): ParsedToolCall | null {
  // Try direct parse first
  const direct = tryParseAndValidate(jsonStr);
  if (direct) return direct;

  // Repair: try adding 1-2 missing closing braces
  for (const suffix of ['}', '}}']) {
    const result = tryParseAndValidate(jsonStr + suffix);
    if (result) return result;
  }

  // Repair: fix extra braces inside code strings
  // Common pattern: code ends with }} instead of } making the JSON malformed
  // Try to find the "code" value and remove trailing extra braces
  const codeMatch = jsonStr.match(/"code"\s*:\s*"([\s\S]*)$/);
  if (codeMatch) {
    const afterCode = codeMatch[1];
    // Try progressively removing trailing } from inside the code string
    // Look for pattern: ...}}"}  or  ...}}"}} and fix brace count
    for (let trim = 1; trim <= 3; trim++) {
      // Find the last "} or "}} that could close the JSON
      const fixRegex = new RegExp(`(\\}{${trim}})"(\\}*)\\s*$`);
      const fixMatch = afterCode.match(fixRegex);
      if (fixMatch) {
        const codeEnd = afterCode.length - fixMatch[0].length;
        const codeContent = afterCode.slice(0, codeEnd);
        // Rebuild with fewer braces in code
        for (let closingBraces = 1; closingBraces <= 3; closingBraces++) {
          const fixed = jsonStr.slice(0, jsonStr.indexOf(afterCode)) +
            codeContent + '"' + '}'.repeat(closingBraces);
          const result = tryParseAndValidate(fixed);
          if (result) return result;
        }
      }
    }
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
  // Pre-validate code syntax for execute_code to give faster, clearer errors
  if (name === 'execute_code' && typeof args.code === 'string') {
    try {
      // Must use AsyncFunction since the code uses top-level await
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      new AsyncFunction('bot', 'sdk', args.code);
    } catch (syntaxErr: any) {
      return `Syntax error in code: ${syntaxErr.message}\nFix the code and try again. Common issue: extra or missing closing braces.`;
    }
  }

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
