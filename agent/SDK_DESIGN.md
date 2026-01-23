# Bot SDK Design Notes

## Architecture: Plumbing vs Porcelain

The SDK has two layers, inspired by Git's architecture:

### Plumbing (`sdk.ts`)
- **Stable, low-level API** that maps 1:1 to the game protocol
- Actions resolve when the game **acknowledges** the action (fast)
- No domain knowledge - just sends commands and receives results
- Rarely changes once established

```typescript
// Plumbing: resolves immediately when game accepts the command
await sdk.sendInteractLoc(tree.x, tree.z, tree.id, 1);
await sdk.sendUseItemOnItem(tinderbox.slot, logs.slot);
```

### Porcelain (`sdk-porcelain.ts`)
- **High-level, domain-aware API** that wraps plumbing with game knowledge
- Actions resolve when the **effect is complete** (slower, but reliable)
- Encodes domain knowledge learned through testing
- Evolves as we discover edge cases

```typescript
// Porcelain: resolves when fire is actually lit (XP gained)
await bot.burnLogs(logs);
```

## Key Learnings

### 1. Game Messages Persist in Buffer

**Problem**: The game client keeps the last N messages in a buffer. Old failure messages like "You can't light a fire here" persist and cause false failures on subsequent attempts.

**Solution**: Added `tick` field to `GameMessage`. Filter messages by tick - only check messages that arrived *after* the action started.

```typescript
const startTick = this.sdk.getState()?.tick || 0;

// Later, in waitForCondition:
for (const msg of state.gameMessages) {
    if (msg.tick > startTick) {  // Only NEW messages
        // Check for failure
    }
}
```

### 2. Level-Up Dialogs Are Multi-Page

**Problem**: When you level up, a dialog appears with multiple pages ("Congratulations, you've reached level 2 Woodcutting", "You can now cut oak trees"). A single click doesn't dismiss it.

**Solution**: Keep clicking the dialog every few ticks while it's open:

```typescript
let lastDialogClickTick = 0;

await this.sdk.waitForCondition(state => {
    // Check success FIRST (before dismissing dialog)
    if (successCondition) return true;

    // Dismiss multi-page dialogs
    if (state.dialog.isOpen && (state.tick - lastDialogClickTick) >= 3) {
        lastDialogClickTick = state.tick;
        this.sdk.sendClickDialog(0).catch(() => {});
    }

    return false;
});
```

### 3. Dialogs Can Appear Mid-Action

**Problem**: Level-up dialogs appear *during* actions (e.g., while making a fire), not before. Pre-action checks don't catch them.

**Solution**: Handle dialogs *inside* the `waitForCondition` loop, not just before starting.

### 4. Identify the Right Success Signal for Each Action

**Problem**: The obvious signal isn't always reliable:
- Logs disappearing could mean dropped, not burned
- Animation completing doesn't guarantee success
- Game messages can be stale or ambiguous

**Solution**: Choose the most reliable signal for each action type:

| Action | Reliable Signal |
|--------|-----------------|
| Firemaking | XP gain (logs disappearing is ambiguous) |
| Woodcutting | Logs in inventory OR tree disappears |
| Pickup | Item appears in inventory |
| Walking | Player position matches destination |
| Talk to NPC | Dialog opens |
| Combat | Target HP decreases or dies |
| Shop Buy | Item appears in inventory (fails if no coins) |
| Shop Sell | Item count decreases in shop player inventory |
| Equip Item | Item leaves inventory (moves to equipment) |
| Eat Food | HP increases OR food count decreases |

```typescript
// Firemaking: XP is reliable because logs can disappear for other reasons
const xpBefore = this.sdk.getSkill('Firemaking')?.experience || 0;
await this.sdk.waitForCondition(state => {
    const xpNow = state.skills.find(s => s.name === 'Firemaking')?.experience || 0;
    return xpNow > xpBefore;
});

// Woodcutting: Either signal works
await this.sdk.waitForCondition(state => {
    const hasLogs = state.inventory.length > invCountBefore;
    const treeGone = !state.nearbyLocs.find(l => l.id === tree.id && l.x === tree.x);
    return hasLogs || treeGone;
});
```

### 5. Check Success Before Side Effects

**Problem**: If you dismiss a dialog before checking for success, you might miss the success state.

**Solution**: Always check the success condition *first* in the wait loop:

```typescript
await this.sdk.waitForCondition(state => {
    // 1. Check success FIRST
    if (xpGained) return true;

    // 2. THEN handle side effects (dismiss dialogs, etc.)
    if (state.dialog.isOpen) { ... }

    return false;
});
```

## Adding New Porcelain Methods

When adding a new high-level action:

1. **Identify the reliable success signal** - What state change proves the action completed?
   - XP gain for skills
   - Item appearing in inventory for pickups
   - Dialog opening for NPC interactions

2. **Handle blocking UI** - Call `dismissBlockingUI()` before starting, and handle dialogs that appear mid-action

3. **Use tick-based message filtering** - If checking game messages, only look at messages newer than `startTick`

4. **Set appropriate timeouts** - Walking + animation can take 30+ seconds for some actions

5. **Test with level-ups** - New accounts level up frequently, which triggers multi-page dialogs

## Common Patterns

### Pattern: Wait for inventory change
```typescript
const countBefore = this.sdk.getInventory().length;
await this.sdk.sendSomeAction();
await this.sdk.waitForCondition(state =>
    state.inventory.length > countBefore
);
```

### Pattern: Wait for entity to disappear
```typescript
await this.sdk.waitForCondition(state =>
    !state.nearbyLocs.find(l => l.x === target.x && l.z === target.z)
);
```

### Pattern: Dismiss dialogs during action
```typescript
let lastClick = 0;
await this.sdk.waitForCondition(state => {
    if (successCondition(state)) return true;

    if (state.dialog.isOpen && (state.tick - lastClick) >= 3) {
        lastClick = state.tick;
        this.sdk.sendClickDialog(0).catch(() => {});
    }
    return false;
});
```

## Available Porcelain Methods

### Skills & Resources
| Method | Description | Success Signal |
|--------|-------------|----------------|
| `chopTree(target?)` | Chops a tree. Target: `NearbyLoc \| string \| RegExp` | Logs in inventory OR tree disappears |
| `burnLogs(target?)` | Burns logs with tinderbox. Target: `InventoryItem \| string \| RegExp` | Firemaking XP gain |
| `pickupItem(target)` | Picks up ground item. Target: `GroundItem \| string \| RegExp` | Item in inventory |

### Movement & Interaction
| Method | Description | Success Signal |
|--------|-------------|----------------|
| `walkTo(x, z, tolerance?)` | Walks to location | Player position within tolerance |
| `talkTo(target)` | Talks to NPC. Target: `NearbyNpc \| string \| RegExp` | Dialog opens |
| `openShop(target?)` | Opens shop via NPC. Target: `NearbyNpc \| string \| RegExp` | Shop interface opens |

### Shop Actions
| Method | Description | Success Signal |
|--------|-------------|----------------|
| `buyFromShop(target, amount?)` | Buys from open shop. Target: `ShopItem \| string \| RegExp` | Item appears in inventory |
| `sellToShop(target, amount?)` | Sells to open shop. Target: `InventoryItem \| ShopItem \| string \| RegExp` | Item leaves shop inventory |

### Equipment & Combat
| Method | Description | Success Signal |
|--------|-------------|----------------|
| `equipItem(target)` | Equips item from inventory. Target: `InventoryItem \| string \| RegExp` | Item leaves inventory |
| `eatFood(target)` | Eats food. Target: `InventoryItem \| string \| RegExp` | HP increases OR food consumed |
| `attackNpc(target)` | Attacks NPC. Target: `NearbyNpc \| string \| RegExp` | Attack command sent (no wait) |

### Helpers
| Method | Description |
|--------|-------------|
| `dismissBlockingUI()` | Closes dialogs/modals |
| `waitForSkillLevel(skill, level)` | Waits for skill level |
| `waitForInventoryItem(pattern)` | Waits for item to appear |
| `waitForDialogClose()` | Waits for dialog to close |
| `navigateDialog(choices)` | Clicks through dialog options |

### 6. Interface Components: buttonType vs iop

**Problem**: Some interfaces (like the smithing anvil menu) have clickable components that don't use `buttonType`. Instead, they use `iop` (inventory operations) like `[Make, Make 5, Make 10]`. The standard `sendClickInterface()` doesn't work on these.

**Solution**: Added `sendClickInterfaceComponent(componentId, optionIndex)` that uses `INV_BUTTON1-5` opcodes:

```typescript
// Smithing interface (id 994) has components with iop, not buttonType:
// 1119: iop=[Make, Make 5, Make 10]  <- dagger
// 1120: iop=[Make, Make 5, Make 10]  <- sword
// 1121: iop=[Make, Make 5, Make 10]  <- scimitar

// Click component 1119 with option 1 (Make)
await sdk.sendClickInterfaceComponent(1119, 1);
```

**How to identify which to use**:
- If `interface.options` array has entries → use `sendClickInterface(optionIndex)`
- If `interface.options` is empty but `debugInfo` shows `iop=[...]` → use `sendClickInterfaceComponent(componentId, optionIndex)`

**Debug output** from BotSDK shows both:
```
Interface 994: 137 children
  1084: buttonType=3 text="Close Window"  <- use sendClickInterface
  1119: iop=[Make, Make 5, Make 10]       <- use sendClickInterfaceComponent
```

### 7. Varps (Variable Player) Control Game State

**Problem**: Bots spawned with save generator were being treated as tutorial players (X < 3200 triggered tutorial checks).

**Solution**: Set varp 281 = 1000 in save file to mark tutorial as complete:

```typescript
// In save-generator.ts
const varps = new Array(varpCount).fill(0);
varps[281] = 1000;  // Tutorial complete
```

**Common varps**:
| Varp | Purpose |
|------|---------|
| 281 | Tutorial progress (1000 = complete) |
| 83 | Attack style selected |
| 43 | Auto-retaliate toggle |

## Files

| File | Purpose |
|------|---------|
| `agent/types.ts` | Shared types for SDK and sync server |
| `agent/sdk.ts` | Plumbing layer - low-level WebSocket API |
| `agent/sdk-porcelain.ts` | Porcelain layer - high-level domain-aware actions |
| `agent/sync.ts` | WebSocket message router (no file I/O) |
| `webclient/src/bot/AgentPanel.ts` | Client-side action handling |
| `webclient/src/client/Client.ts` | Low-level client methods (clickInterfaceIop, etc.) |
| `test/utils/save-generator.ts` | Generate pre-configured save files for tests |
