// Bot SDK - Porcelain Layer
// High-level domain-aware methods that wrap plumbing with game knowledge
// Actions resolve when the EFFECT is complete (not just acknowledged)
// This layer evolves through testing as we learn domain edge cases

import { BotSDK } from './sdk';
import type {
    BotWorldState,
    ActionResult,
    SkillState,
    InventoryItem,
    NearbyNpc,
    NearbyLoc,
    GroundItem,
    DialogState,
    ShopItem
} from './types';

export interface ChopTreeResult {
    success: boolean;
    logs?: InventoryItem;
    message: string;
}

export interface BurnLogsResult {
    success: boolean;
    xpGained: number;
    message: string;
}

export interface PickupResult {
    success: boolean;
    item?: InventoryItem;
    message: string;
}

export interface TalkResult {
    success: boolean;
    dialog?: DialogState;
    message: string;
}

export interface ShopResult {
    success: boolean;
    item?: InventoryItem;
    message: string;
}

export interface EquipResult {
    success: boolean;
    message: string;
}

export interface EatResult {
    success: boolean;
    hpGained: number;
    message: string;
}

export interface AttackResult {
    success: boolean;
    message: string;
}

export class BotActions {
    constructor(private sdk: BotSDK) {}

    // ============ Porcelain: UI Helpers ============

    /**
     * Dismisses any blocking UI (level-up dialogs, modals, etc.)
     * Many actions can't proceed while dialogs are open, so this
     * should be called before starting actions.
     */
    async dismissBlockingUI(): Promise<void> {
        const maxAttempts = 10;
        for (let i = 0; i < maxAttempts; i++) {
            const state = this.sdk.getState();
            if (!state) break;

            // Check for open dialog (click to continue)
            if (state.dialog.isOpen) {
                console.log(`  [dismissBlockingUI] Dismissing dialog (attempt ${i + 1})`);
                await this.sdk.sendClickDialog(0);
                await this.sdk.waitForStateChange(2000).catch(() => {});
                continue;
            }

            // No blocking UI found
            break;
        }
    }

    // ============ Porcelain: Smart Actions ============
    // These encode domain knowledge about "when is this done?"

    /**
     * Chops a tree and waits for logs to appear in inventory.
     * Finds the nearest tree matching the pattern if not specified.
     */
    async chopTree(target?: NearbyLoc | string | RegExp): Promise<ChopTreeResult> {
        // Dismiss any blocking UI before starting
        await this.dismissBlockingUI();

        const tree = this.resolveLocation(target, /^tree$/i);
        if (!tree) {
            return { success: false, message: 'No tree found' };
        }

        const invCountBefore = this.sdk.getInventory().length;
        const result = await this.sdk.sendInteractLoc(tree.x, tree.z, tree.id, 1);

        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            // Wait for: new item in inventory OR tree disappears
            await this.sdk.waitForCondition(state => {
                const newItem = state.inventory.length > invCountBefore;
                const treeGone = !state.nearbyLocs.find(l =>
                    l.x === tree.x && l.z === tree.z && l.id === tree.id
                );
                return newItem || treeGone;
            }, 30000);

            const logs = this.sdk.findInventoryItem(/logs/i);
            return {
                success: true,
                logs: logs || undefined,
                message: 'Chopped tree'
            };
        } catch {
            return { success: false, message: 'Timed out waiting for tree chop' };
        }
    }

    /**
     * Burns logs with a tinderbox and waits for firemaking to complete.
     * Automatically finds tinderbox and logs if not specified.
     *
     * This function will NOT return until:
     * - SUCCESS: Firemaking XP increases (fire was lit)
     * - FAILURE: Timeout expires, or failure message detected
     */
    async burnLogs(logsTarget?: InventoryItem | string | RegExp): Promise<BurnLogsResult> {
        // Dismiss any blocking UI (level-up dialogs, etc.) before starting
        await this.dismissBlockingUI();

        const tinderbox = this.sdk.findInventoryItem(/tinderbox/i);
        if (!tinderbox) {
            return { success: false, xpGained: 0, message: 'No tinderbox in inventory' };
        }

        const logs = this.resolveInventoryItem(logsTarget, /logs/i);
        if (!logs) {
            return { success: false, xpGained: 0, message: 'No logs in inventory' };
        }

        const fmBefore = this.sdk.getSkill('Firemaking')?.experience || 0;
        const logsCountBefore = this.sdk.getInventory().filter(i => /logs/i.test(i.name)).length;

        const result = await this.sdk.sendUseItemOnItem(tinderbox.slot, logs.slot);
        if (!result.success) {
            return { success: false, xpGained: 0, message: result.message };
        }

        // Record the current tick so we can filter for NEW messages only
        const startTick = this.sdk.getState()?.tick || 0;

        // Wait for firemaking to complete - this is the key domain knowledge:
        // - XP gain is the ONLY reliable success indicator
        // - Logs disappearing alone doesn't mean success (could be dropped, etc.)
        // - Failure messages are checked, but ONLY if they arrived after we started (using tick)
        // - Timeout of 30s allows for walking + animation
        // - Level-up dialogs can appear mid-action and must be dismissed
        let lastDialogClickTick = 0;
        try {
            await this.sdk.waitForCondition(state => {
                // Check for XP gain - this is SUCCESS
                const fmXp = state.skills.find(s => s.name === 'Firemaking')?.experience || 0;
                if (fmXp > fmBefore) {
                    return true;  // Fire was lit!
                }

                // If a dialog opened during the action (e.g., level-up), dismiss it
                // Level-up dialogs can have multiple pages, so keep clicking every few ticks
                // We do this AFTER checking XP so we don't miss the success
                if (state.dialog.isOpen && (state.tick - lastDialogClickTick) >= 3) {
                    lastDialogClickTick = state.tick;
                    // Fire and forget - the next state update will show if it closed
                    this.sdk.sendClickDialog(0).catch(() => {});
                }

                // Check for failure messages that arrived AFTER we started
                // (filtering by tick prevents old messages from causing false failures)
                const failureMessages = [
                    "can't light a fire",
                    "you need to move",
                    "can't do that here"
                ];
                for (const msg of state.gameMessages) {
                    // Only check messages that arrived after we started
                    if (msg.tick > startTick) {
                        const text = msg.text.toLowerCase();
                        if (failureMessages.some(f => text.includes(f))) {
                            return true;  // Will check XP below to determine success/failure
                        }
                    }
                }

                return false;
            }, 30000);

            const fmAfter = this.sdk.getSkill('Firemaking')?.experience || 0;
            const xpGained = fmAfter - fmBefore;

            return {
                success: xpGained > 0,
                xpGained,
                message: xpGained > 0 ? 'Burned logs' : 'Failed to light fire (possibly bad location)'
            };
        } catch {
            return { success: false, xpGained: 0, message: 'Timed out waiting for fire' };
        }
    }

    /**
     * Picks up a ground item and waits for it to appear in inventory.
     */
    async pickupItem(target: GroundItem | string | RegExp): Promise<PickupResult> {
        const item = this.resolveGroundItem(target);
        if (!item) {
            return { success: false, message: 'Item not found on ground' };
        }

        const invCountBefore = this.sdk.getInventory().length;
        const result = await this.sdk.sendPickup(item.x, item.z, item.id);

        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            // Wait for inventory count to increase
            await this.sdk.waitForCondition(state =>
                state.inventory.length > invCountBefore,
                10000
            );

            // Find the item that was just picked up
            const pickedUp = this.sdk.getInventory().find(i =>
                i.id === item.id
            );

            return {
                success: true,
                item: pickedUp,
                message: `Picked up ${item.name}`
            };
        } catch {
            return { success: false, message: 'Timed out waiting for pickup' };
        }
    }

    /**
     * Talks to an NPC and waits for dialog to open.
     */
    async talkTo(target: NearbyNpc | string | RegExp): Promise<TalkResult> {
        const npc = this.resolveNpc(target);
        if (!npc) {
            return { success: false, message: 'NPC not found' };
        }

        const result = await this.sdk.sendTalkToNpc(npc.index);
        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            // Wait for dialog to open
            const state = await this.sdk.waitForCondition(s =>
                s.dialog.isOpen,
                10000
            );

            return {
                success: true,
                dialog: state.dialog,
                message: `Talking to ${npc.name}`
            };
        } catch {
            return { success: false, message: 'Timed out waiting for dialog' };
        }
    }

    /**
     * Walks to a location and waits until the player arrives (or gets close enough).
     */
    async walkTo(x: number, z: number, tolerance: number = 1): Promise<ActionResult> {
        const MAX_STEP = 15; // Max tiles per walk command
        const MAX_ATTEMPTS = 100; // More attempts for longer walks

        let consecutiveFailures = 0;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const state = this.sdk.getState();
            if (!state?.player) {
                return { success: false, message: 'No player state' };
            }

            const px = state.player.worldX;
            const pz = state.player.worldZ;
            const dx = x - px;
            const dz = z - pz;
            const dist = Math.sqrt(dx * dx + dz * dz);

            // Close enough?
            if (dist <= tolerance) {
                return { success: true, message: `Arrived at (${x}, ${z})` };
            }

            // Calculate intermediate target (move MAX_STEP tiles toward goal)
            let targetX = x;
            let targetZ = z;
            if (dist > MAX_STEP) {
                const ratio = MAX_STEP / dist;
                targetX = Math.round(px + dx * ratio);
                targetZ = Math.round(pz + dz * ratio);
            }

            // Send walk command
            const result = await this.sdk.sendWalk(targetX, targetZ);
            if (!result.success) {
                consecutiveFailures++;
                if (consecutiveFailures >= 3) {
                    return result;
                }
                // Small delay and retry
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            consecutiveFailures = 0;

            // Wait until we've moved (or timeout)
            try {
                await this.sdk.waitForCondition(s => {
                    if (!s.player) return false;
                    const newDx = Math.abs(s.player.worldX - targetX);
                    const newDz = Math.abs(s.player.worldZ - targetZ);
                    return (newDx <= 2 && newDz <= 2);
                }, 10000);
            } catch {
                // Timeout - check if we moved
                const afterState = this.sdk.getState();
                if (afterState?.player?.worldX === px && afterState?.player?.worldZ === pz) {
                    // Didn't move at all - might be blocked, try smaller steps
                    for (const [ddx, ddz] of [[0, -5], [5, 0], [0, 5], [-5, 0]]) {
                        await this.sdk.sendWalk(px + ddx, pz + ddz).catch(() => {});
                        await new Promise(r => setTimeout(r, 2000));
                        const newState = this.sdk.getState();
                        if (newState?.player?.worldX !== px || newState?.player?.worldZ !== pz) {
                            break; // We moved!
                        }
                    }
                }
            }
        }

        return { success: false, message: 'Max walk attempts exceeded' };
    }

    // ============ Porcelain: Shop Actions ============

    /**
     * Opens a shop by trading with a shopkeeper NPC.
     * Waits for the shop interface to open.
     */
    async openShop(target: NearbyNpc | string | RegExp = /shop\s*keeper/i): Promise<ActionResult> {
        const npc = this.resolveNpc(target);
        if (!npc) {
            return { success: false, message: 'Shopkeeper not found' };
        }

        // Find "Trade" option
        const tradeOpt = npc.optionsWithIndex.find(o => /trade/i.test(o.text));
        if (!tradeOpt) {
            return { success: false, message: 'No trade option on NPC' };
        }

        const result = await this.sdk.sendInteractNpc(npc.index, tradeOpt.opIndex);
        if (!result.success) {
            return result;
        }

        try {
            await this.sdk.waitForCondition(state => state.shop.isOpen, 10000);
            return { success: true, message: `Opened shop: ${this.sdk.getState()?.shop.title}` };
        } catch {
            return { success: false, message: 'Timed out waiting for shop to open' };
        }
    }

    /**
     * Buys an item from an open shop.
     * Waits for the item to appear in inventory.
     * Fails if item doesn't appear (e.g., no coins, shop out of stock).
     */
    async buyFromShop(target: ShopItem | string | RegExp, amount: number = 1): Promise<ShopResult> {
        const shop = this.sdk.getState()?.shop;
        if (!shop?.isOpen) {
            return { success: false, message: 'Shop is not open' };
        }

        const shopItem = this.resolveShopItem(target, shop.shopItems);
        if (!shopItem) {
            return { success: false, message: `Item not found in shop: ${target}` };
        }

        // Track inventory before purchase
        const invBefore = this.sdk.getInventory();
        const hadItemBefore = invBefore.find(i => i.id === shopItem.id);
        const countBefore = hadItemBefore?.count ?? 0;

        const result = await this.sdk.sendShopBuy(shopItem.slot, amount);
        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            // Wait for item to appear or count to increase
            await this.sdk.waitForCondition(state => {
                const item = state.inventory.find(i => i.id === shopItem.id);
                if (!item) return false;
                return item.count > countBefore;
            }, 5000);

            const boughtItem = this.sdk.getInventory().find(i => i.id === shopItem.id);
            return {
                success: true,
                item: boughtItem,
                message: `Bought ${shopItem.name} x${amount}`
            };
        } catch {
            return { success: false, message: `Failed to buy ${shopItem.name} (no coins or out of stock?)` };
        }
    }

    /**
     * Sells an item to an open shop.
     * Waits for the item to leave inventory (or count to decrease).
     * Accepts InventoryItem, ShopItem (from shop.playerItems), or a pattern.
     */
    async sellToShop(target: InventoryItem | ShopItem | string | RegExp, amount: number = 1): Promise<ShopResult> {
        const shop = this.sdk.getState()?.shop;
        if (!shop?.isOpen) {
            return { success: false, message: 'Shop is not open' };
        }

        // Find item in player's shop inventory (items available to sell)
        const sellItem = this.resolveShopItem(target, shop.playerItems);
        if (!sellItem) {
            return { success: false, message: `Item not found to sell: ${target}` };
        }

        const countBefore = sellItem.count;

        const result = await this.sdk.sendShopSell(sellItem.slot, amount);
        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            // Wait for item count to decrease or item to disappear
            await this.sdk.waitForCondition(state => {
                const item = state.shop.playerItems.find(i => i.id === sellItem.id);
                if (!item) return true;  // Item gone
                return item.count < countBefore;  // Count decreased
            }, 5000);

            return {
                success: true,
                message: `Sold ${sellItem.name} x${amount}`
            };
        } catch {
            return { success: false, message: `Failed to sell ${sellItem.name}` };
        }
    }

    // ============ Porcelain: Equipment & Combat ============

    /**
     * Equips an item from inventory.
     * Waits for the item to move to equipment slot.
     */
    async equipItem(target: InventoryItem | string | RegExp): Promise<EquipResult> {
        const item = this.resolveInventoryItem(target, /./);
        if (!item) {
            return { success: false, message: `Item not found: ${target}` };
        }

        // Find "Wield" or "Wear" option
        const equipOpt = item.optionsWithIndex.find(o => /wield|wear|equip/i.test(o.text));
        if (!equipOpt) {
            return { success: false, message: `No equip option on ${item.name}` };
        }

        const invCountBefore = this.sdk.getInventory().length;
        const result = await this.sdk.sendUseItem(item.slot, equipOpt.opIndex);
        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            // Wait for item to leave inventory (moved to equipment)
            await this.sdk.waitForCondition(state =>
                !state.inventory.find(i => i.slot === item.slot && i.id === item.id),
                5000
            );
            return { success: true, message: `Equipped ${item.name}` };
        } catch {
            return { success: false, message: `Failed to equip ${item.name}` };
        }
    }

    /**
     * Eats food from inventory.
     * Waits for HP to increase or food to be consumed.
     */
    async eatFood(target: InventoryItem | string | RegExp): Promise<EatResult> {
        const food = this.resolveInventoryItem(target, /./);
        if (!food) {
            return { success: false, hpGained: 0, message: `Food not found: ${target}` };
        }

        // Find "Eat" option
        const eatOpt = food.optionsWithIndex.find(o => /eat/i.test(o.text));
        if (!eatOpt) {
            return { success: false, hpGained: 0, message: `No eat option on ${food.name}` };
        }

        const hpBefore = this.sdk.getSkill('Hitpoints')?.level ?? 10;
        const foodCountBefore = this.sdk.getInventory().filter(i => i.id === food.id).length;

        const result = await this.sdk.sendUseItem(food.slot, eatOpt.opIndex);
        if (!result.success) {
            return { success: false, hpGained: 0, message: result.message };
        }

        try {
            // Wait for HP to increase OR food count to decrease
            await this.sdk.waitForCondition(state => {
                const hp = state.skills.find(s => s.name === 'Hitpoints')?.level ?? 10;
                const foodCount = state.inventory.filter(i => i.id === food.id).length;
                return hp > hpBefore || foodCount < foodCountBefore;
            }, 5000);

            const hpAfter = this.sdk.getSkill('Hitpoints')?.level ?? 10;
            return {
                success: true,
                hpGained: hpAfter - hpBefore,
                message: `Ate ${food.name}`
            };
        } catch {
            return { success: false, hpGained: 0, message: `Failed to eat ${food.name}` };
        }
    }

    /**
     * Attacks an NPC.
     * Sends the attack command (doesn't wait for kill - that would take too long).
     */
    async attackNpc(target: NearbyNpc | string | RegExp): Promise<AttackResult> {
        const npc = this.resolveNpc(target);
        if (!npc) {
            return { success: false, message: `NPC not found: ${target}` };
        }

        // Find "Attack" option
        const attackOpt = npc.optionsWithIndex.find(o => /attack/i.test(o.text));
        if (!attackOpt) {
            return { success: false, message: `No attack option on ${npc.name}` };
        }

        const result = await this.sdk.sendInteractNpc(npc.index, attackOpt.opIndex);
        if (!result.success) {
            return { success: false, message: result.message };
        }

        return { success: true, message: `Attacking ${npc.name}` };
    }

    // ============ Porcelain: Condition Helpers ============

    /**
     * Waits until a skill reaches the target level.
     */
    async waitForSkillLevel(skillName: string, targetLevel: number, timeout: number = 60000): Promise<SkillState> {
        const state = await this.sdk.waitForCondition(s => {
            const skill = s.skills.find(sk => sk.name.toLowerCase() === skillName.toLowerCase());
            return skill !== undefined && skill.baseLevel >= targetLevel;
        }, timeout);

        return state.skills.find(s => s.name.toLowerCase() === skillName.toLowerCase())!;
    }

    /**
     * Waits until an item appears in inventory.
     */
    async waitForInventoryItem(pattern: string | RegExp, timeout: number = 30000): Promise<InventoryItem> {
        const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;

        const state = await this.sdk.waitForCondition(s =>
            s.inventory.some(i => regex.test(i.name)),
            timeout
        );

        return state.inventory.find(i => regex.test(i.name))!;
    }

    /**
     * Waits until dialog closes.
     */
    async waitForDialogClose(timeout: number = 30000): Promise<void> {
        await this.sdk.waitForCondition(s => !s.dialog.isOpen, timeout);
    }

    /**
     * Waits until the player is idle (not moving, no pending actions).
     * This is a heuristic - checks if player position hasn't changed.
     */
    async waitForIdle(timeout: number = 10000): Promise<void> {
        // Get initial position
        const initialState = this.sdk.getState();
        if (!initialState?.player) {
            throw new Error('No player state');
        }

        const initialX = initialState.player.x;
        const initialZ = initialState.player.z;

        // Wait for next state update
        await this.sdk.waitForStateChange(timeout);

        // Check if position is the same
        await this.sdk.waitForCondition(state => {
            if (!state.player) return false;
            return state.player.x === initialX && state.player.z === initialZ;
        }, timeout);
    }

    // ============ Porcelain: Sequences ============

    /**
     * Navigates through a dialog by selecting options in sequence.
     * Options can be indices (1-based) or text patterns to match.
     */
    async navigateDialog(choices: (number | string | RegExp)[]): Promise<void> {
        for (const choice of choices) {
            // Wait for dialog to be ready
            await this.sdk.waitForCondition(s =>
                s.dialog.isOpen && !s.dialog.isWaiting,
                10000
            );

            const dialog = this.sdk.getDialog();
            if (!dialog) {
                throw new Error('Dialog closed unexpectedly');
            }

            let optionIndex: number;

            if (typeof choice === 'number') {
                optionIndex = choice;
            } else {
                // Find option matching the pattern
                const regex = typeof choice === 'string'
                    ? new RegExp(choice, 'i')
                    : choice;

                const match = dialog.options.find(o => regex.test(o.text));
                if (!match) {
                    // No options means "click to continue" (option 0)
                    if (dialog.options.length === 0) {
                        optionIndex = 0;
                    } else {
                        throw new Error(`No dialog option matching: ${choice}`);
                    }
                } else {
                    optionIndex = match.index;
                }
            }

            await this.sdk.sendClickDialog(optionIndex);

            // Small delay for dialog to process
            await this.sdk.waitForStateChange(5000).catch(() => {});
        }
    }

    // ============ Resolution Helpers ============

    private resolveLocation(
        target: NearbyLoc | string | RegExp | undefined,
        defaultPattern: RegExp
    ): NearbyLoc | null {
        if (!target) {
            return this.sdk.findNearbyLoc(defaultPattern);
        }
        if (typeof target === 'object' && 'x' in target) {
            return target;
        }
        return this.sdk.findNearbyLoc(target);
    }

    private resolveInventoryItem(
        target: InventoryItem | string | RegExp | undefined,
        defaultPattern: RegExp
    ): InventoryItem | null {
        if (!target) {
            return this.sdk.findInventoryItem(defaultPattern);
        }
        if (typeof target === 'object' && 'slot' in target) {
            return target;
        }
        return this.sdk.findInventoryItem(target);
    }

    private resolveGroundItem(target: GroundItem | string | RegExp): GroundItem | null {
        if (typeof target === 'object' && 'x' in target) {
            return target;
        }
        return this.sdk.findGroundItem(target);
    }

    private resolveNpc(target: NearbyNpc | string | RegExp): NearbyNpc | null {
        if (typeof target === 'object' && 'index' in target) {
            return target;
        }
        return this.sdk.findNearbyNpc(target);
    }

    private resolveShopItem(
        target: ShopItem | InventoryItem | string | RegExp,
        items: ShopItem[]
    ): ShopItem | null {
        // If it's an object with id/name, find matching item in the shop's item list
        if (typeof target === 'object' && 'id' in target && 'name' in target) {
            return items.find(i => i.id === target.id) ?? null;
        }
        // Otherwise it's a pattern - search by name
        const regex = typeof target === 'string' ? new RegExp(target, 'i') : target;
        return items.find(i => regex.test(i.name)) ?? null;
    }
}
