// Bot SDK - Porcelain Layer
// High-level domain-aware methods that wrap plumbing with game knowledge
// Actions resolve when the EFFECT is complete (not just acknowledged)

import { BotSDK } from './index';
import type {
    BotWorldState,
    ActionResult,
    SkillState,
    InventoryItem,
    NearbyNpc,
    NearbyLoc,
    GroundItem,
    DialogState,
    ShopItem,
    ChopTreeResult,
    BurnLogsResult,
    PickupResult,
    TalkResult,
    ShopResult,
    ShopSellResult,
    SellAmount,
    EquipResult,
    UnequipResult,
    EatResult,
    AttackResult,
    CastSpellResult,
    OpenDoorResult,
    FletchResult,
    CraftLeatherResult,
    OpenBankResult,
    BankDepositResult,
    BankWithdrawResult
} from './types';

export class BotActions {
    constructor(private sdk: BotSDK) {}

    // ============ Private Helpers ============

    private async waitForMovementComplete(
        targetX: number,
        targetZ: number,
        tolerance: number = 3
    ): Promise<{ arrived: boolean; stoppedMoving: boolean; x: number; z: number }> {
        const POLL_INTERVAL = 150;
        const STUCK_THRESHOLD = 600;
        const MIN_TIMEOUT = 2000;
        const TILES_PER_SECOND = 4.5;

        const startState = this.sdk.getState();
        if (!startState?.player) {
            return { arrived: false, stoppedMoving: true, x: 0, z: 0 };
        }

        const startX = startState.player.worldX;
        const startZ = startState.player.worldZ;

        const distance = Math.sqrt(
            Math.pow(targetX - startX, 2) + Math.pow(targetZ - startZ, 2)
        );
        const expectedTime = (distance / TILES_PER_SECOND) * 1000;
        const maxTimeout = Math.max(MIN_TIMEOUT, expectedTime * 1.5);

        let lastX = startX;
        let lastZ = startZ;
        let lastMoveTime = Date.now();
        const startTime = Date.now();

        while (Date.now() - startTime < maxTimeout) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

            const state = this.sdk.getState();
            if (!state?.player) {
                return { arrived: false, stoppedMoving: true, x: lastX, z: lastZ };
            }

            const currentX = state.player.worldX;
            const currentZ = state.player.worldZ;

            const distToTarget = Math.sqrt(
                Math.pow(targetX - currentX, 2) + Math.pow(targetZ - currentZ, 2)
            );
            if (distToTarget <= tolerance) {
                return { arrived: true, stoppedMoving: false, x: currentX, z: currentZ };
            }

            if (currentX !== lastX || currentZ !== lastZ) {
                lastMoveTime = Date.now();
                lastX = currentX;
                lastZ = currentZ;
            } else {
                if (Date.now() - lastMoveTime > STUCK_THRESHOLD) {
                    return { arrived: false, stoppedMoving: true, x: currentX, z: currentZ };
                }
            }
        }

        const finalState = this.sdk.getState();
        const finalX = finalState?.player?.worldX ?? lastX;
        const finalZ = finalState?.player?.worldZ ?? lastZ;
        const finalDist = Math.sqrt(
            Math.pow(targetX - finalX, 2) + Math.pow(targetZ - finalZ, 2)
        );

        return {
            arrived: finalDist <= tolerance,
            stoppedMoving: true,
            x: finalX,
            z: finalZ
        };
    }

    // ============ Porcelain: UI Helpers ============

    async dismissBlockingUI(): Promise<void> {
        const maxAttempts = 10;
        for (let i = 0; i < maxAttempts; i++) {
            const state = this.sdk.getState();
            if (!state) break;

            if (state.dialog.isOpen) {
                console.log(`  [dismissBlockingUI] Dismissing dialog (attempt ${i + 1})`);
                await this.sdk.sendClickDialog(0);
                await this.sdk.waitForStateChange(2000).catch(() => {});
                continue;
            }

            break;
        }
    }

    // ============ Porcelain: Smart Actions ============

    async openDoor(target?: NearbyLoc | string | RegExp): Promise<OpenDoorResult> {
        const door = this.resolveLocation(target, /door|gate/i);
        if (!door) {
            return { success: false, message: 'No door found nearby', reason: 'door_not_found' };
        }

        const openOpt = door.optionsWithIndex.find(o => /^open$/i.test(o.text));
        if (!openOpt) {
            const closeOpt = door.optionsWithIndex.find(o => /^close$/i.test(o.text));
            if (closeOpt) {
                return { success: true, message: `${door.name} is already open`, reason: 'already_open', door };
            }
            return { success: false, message: `${door.name} has no Open option (options: ${door.options.join(', ')})`, reason: 'no_open_option', door };
        }

        if (door.distance > 2) {
            const walkResult = await this.walkTo(door.x, door.z);
            if (!walkResult.success) {
                return { success: false, message: `Could not walk to ${door.name}: ${walkResult.message}`, reason: 'walk_failed', door };
            }

            const doorsNow = this.sdk.getNearbyLocs().filter(l =>
                l.x === door.x && l.z === door.z && /door|gate/i.test(l.name)
            );
            const refreshedDoor = doorsNow[0];
            if (!refreshedDoor) {
                return { success: true, message: `${door.name} is no longer visible (may have been opened)`, door };
            }

            const refreshedOpenOpt = refreshedDoor.optionsWithIndex.find(o => /^open$/i.test(o.text));
            if (!refreshedOpenOpt) {
                const hasClose = refreshedDoor.optionsWithIndex.some(o => /^close$/i.test(o.text));
                if (hasClose) {
                    return { success: true, message: `${door.name} is already open`, reason: 'already_open', door: refreshedDoor };
                }
                return { success: false, message: `${door.name} no longer has Open option`, reason: 'no_open_option', door: refreshedDoor };
            }

            await this.sdk.sendInteractLoc(refreshedDoor.x, refreshedDoor.z, refreshedDoor.id, refreshedOpenOpt.opIndex);
        } else {
            await this.sdk.sendInteractLoc(door.x, door.z, door.id, openOpt.opIndex);
        }

        const doorX = door.x;
        const doorZ = door.z;
        const startTick = this.sdk.getState()?.tick || 0;

        try {
            await this.sdk.waitForCondition(state => {
                for (const msg of state.gameMessages) {
                    if (msg.tick > startTick) {
                        const text = msg.text.toLowerCase();
                        if (text.includes("can't reach") || text.includes("cannot reach")) {
                            return true;
                        }
                    }
                }

                const doorNow = state.nearbyLocs.find(l =>
                    l.x === doorX && l.z === doorZ && /door|gate/i.test(l.name)
                );
                if (!doorNow) {
                    return true;
                }
                const hasClose = doorNow.optionsWithIndex.some(o => /^close$/i.test(o.text));
                const hasOpen = doorNow.optionsWithIndex.some(o => /^open$/i.test(o.text));
                return hasClose && !hasOpen;
            }, 5000);

            const finalState = this.sdk.getState();

            for (const msg of finalState?.gameMessages ?? []) {
                if (msg.tick > startTick) {
                    const text = msg.text.toLowerCase();
                    if (text.includes("can't reach") || text.includes("cannot reach")) {
                        return { success: false, message: `Cannot reach ${door.name} - still blocked`, reason: 'open_failed', door };
                    }
                }
            }

            const doorAfter = finalState?.nearbyLocs.find(l =>
                l.x === doorX && l.z === doorZ && /door|gate/i.test(l.name)
            );

            if (!doorAfter) {
                return { success: true, message: `Opened ${door.name}`, door };
            }

            const hasCloseNow = doorAfter.optionsWithIndex.some(o => /^close$/i.test(o.text));
            if (hasCloseNow) {
                return { success: true, message: `Opened ${door.name}`, door: doorAfter };
            }

            return { success: false, message: `${door.name} did not open`, reason: 'open_failed', door: doorAfter };

        } catch {
            return { success: false, message: `Timeout waiting for ${door.name} to open`, reason: 'timeout', door };
        }
    }

    async chopTree(target?: NearbyLoc | string | RegExp): Promise<ChopTreeResult> {
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
            await this.sdk.waitForCondition(state => {
                const newItem = state.inventory.length > invCountBefore;
                const treeGone = !state.nearbyLocs.find(l =>
                    l.x === tree.x && l.z === tree.z && l.id === tree.id
                );
                return newItem || treeGone;
            }, 30000);

            const logs = this.sdk.findInventoryItem(/logs/i);
            return { success: true, logs: logs || undefined, message: 'Chopped tree' };
        } catch {
            return { success: false, message: 'Timed out waiting for tree chop' };
        }
    }

    async burnLogs(logsTarget?: InventoryItem | string | RegExp): Promise<BurnLogsResult> {
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

        const result = await this.sdk.sendUseItemOnItem(tinderbox.slot, logs.slot);
        if (!result.success) {
            return { success: false, xpGained: 0, message: result.message };
        }

        const startTick = this.sdk.getState()?.tick || 0;
        let lastDialogClickTick = 0;

        try {
            await this.sdk.waitForCondition(state => {
                const fmXp = state.skills.find(s => s.name === 'Firemaking')?.experience || 0;
                if (fmXp > fmBefore) {
                    return true;
                }

                if (state.dialog.isOpen && (state.tick - lastDialogClickTick) >= 3) {
                    lastDialogClickTick = state.tick;
                    this.sdk.sendClickDialog(0).catch(() => {});
                }

                const failureMessages = ["can't light a fire", "you need to move", "can't do that here"];
                for (const msg of state.gameMessages) {
                    if (msg.tick > startTick) {
                        const text = msg.text.toLowerCase();
                        if (failureMessages.some(f => text.includes(f))) {
                            return true;
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

    async pickupItem(target: GroundItem | string | RegExp): Promise<PickupResult> {
        const item = this.resolveGroundItem(target);
        if (!item) {
            return { success: false, message: 'Item not found on ground', reason: 'item_not_found' };
        }

        const invCountBefore = this.sdk.getInventory().length;
        const startTick = this.sdk.getState()?.tick || 0;
        const result = await this.sdk.sendPickup(item.x, item.z, item.id);

        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            const finalState = await this.sdk.waitForCondition(state => {
                for (const msg of state.gameMessages) {
                    if (msg.tick > startTick) {
                        const text = msg.text.toLowerCase();
                        if (text.includes("can't reach") || text.includes("cannot reach")) {
                            return true;
                        }
                        if (text.includes("inventory") && text.includes("full")) {
                            return true;
                        }
                    }
                }
                return state.inventory.length > invCountBefore;
            }, 10000);

            for (const msg of finalState.gameMessages) {
                if (msg.tick > startTick) {
                    const text = msg.text.toLowerCase();
                    if (text.includes("can't reach") || text.includes("cannot reach")) {
                        return { success: false, message: `Cannot reach ${item.name} at (${item.x}, ${item.z}) - path blocked`, reason: 'cant_reach' };
                    }
                    if (text.includes("inventory") && text.includes("full")) {
                        return { success: false, message: 'Inventory is full', reason: 'inventory_full' };
                    }
                }
            }

            const pickedUp = this.sdk.getInventory().find(i => i.id === item.id);
            return { success: true, item: pickedUp, message: `Picked up ${item.name}` };
        } catch {
            return { success: false, message: 'Timed out waiting for pickup', reason: 'timeout' };
        }
    }

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
            const state = await this.sdk.waitForCondition(s => s.dialog.isOpen, 10000);
            return { success: true, dialog: state.dialog, message: `Talking to ${npc.name}` };
        } catch {
            return { success: false, message: 'Timed out waiting for dialog' };
        }
    }

    async walkTo(x: number, z: number, tolerance: number = 3): Promise<ActionResult> {
        const startState = this.sdk.getState();
        if (!startState?.player) {
            return { success: false, message: 'No player state' };
        }

        const startX = startState.player.worldX;
        const startZ = startState.player.worldZ;

        const startDist = Math.sqrt(Math.pow(x - startX, 2) + Math.pow(z - startZ, 2));
        if (startDist <= tolerance) {
            return { success: true, message: `Already at (${x}, ${z})` };
        }

        const MAX_PATH_QUERIES = 80;
        let stuckCount = 0;

        for (let query = 0; query < MAX_PATH_QUERIES; query++) {
            const currentState = this.sdk.getState();
            if (!currentState?.player) {
                return { success: false, message: 'Lost player state' };
            }

            const currentX = currentState.player.worldX;
            const currentZ = currentState.player.worldZ;

            const distToGoal = Math.sqrt(Math.pow(x - currentX, 2) + Math.pow(z - currentZ, 2));
            if (distToGoal <= tolerance) {
                return { success: true, message: `Arrived at (${currentX}, ${currentZ})` };
            }

            let pathResult = await this.sdk.sendFindPath(x, z, 500);

            if ((!pathResult.waypoints || pathResult.waypoints.length === 0) && distToGoal > 40) {
                const INTERMEDIATE_DISTANCES = [60, 40, 25];
                const PERPENDICULAR_OFFSETS = [0, 15, -15, 30, -30];

                const dirX = (x - currentX) / distToGoal;
                const dirZ = (z - currentZ) / distToGoal;
                const perpX = -dirZ;
                const perpZ = dirX;

                intermediateSearch:
                for (const dist of INTERMEDIATE_DISTANCES) {
                    if (dist >= distToGoal) continue;

                    for (const offset of PERPENDICULAR_OFFSETS) {
                        const intermediateX = Math.round(currentX + dirX * dist + perpX * offset);
                        const intermediateZ = Math.round(currentZ + dirZ * dist + perpZ * offset);

                        pathResult = await this.sdk.sendFindPath(intermediateX, intermediateZ, 500);
                        if (pathResult.waypoints && pathResult.waypoints.length > 0) {
                            break intermediateSearch;
                        }
                    }
                }
            }

            if (!pathResult.success || !pathResult.waypoints || pathResult.waypoints.length === 0) {
                await this.sdk.sendWalk(x, z, true);
                try {
                    await this.sdk.waitForCondition(s => {
                        if (!s.player) return false;
                        const d = Math.sqrt(Math.pow(x - s.player.worldX, 2) + Math.pow(z - s.player.worldZ, 2));
                        return d <= tolerance;
                    }, 10000);
                    return { success: true, message: `Arrived at (${x}, ${z})` };
                } catch {
                    return { success: false, message: `No path found to (${x}, ${z})` };
                }
            }

            const waypoints = pathResult.waypoints;

            const WAYPOINT_STEP = 5;
            for (let wpIndex = Math.min(WAYPOINT_STEP - 1, waypoints.length - 1); wpIndex < waypoints.length; wpIndex += WAYPOINT_STEP) {
                const wp = waypoints[wpIndex];
                if (!wp) continue;
                await this.sdk.sendWalk(wp.x, wp.z, true);

                const moveResult = await this.waitForMovementComplete(wp.x, wp.z, 3);

                if (!this.sdk.getState()?.player) {
                    return { success: false, message: 'Lost connection during walk' };
                }

                const newDist = Math.sqrt(Math.pow(x - moveResult.x, 2) + Math.pow(z - moveResult.z, 2));
                if (newDist <= tolerance) {
                    return { success: true, message: `Arrived at (${moveResult.x}, ${moveResult.z})` };
                }

                if (moveResult.stoppedMoving && !moveResult.arrived) {
                    break;
                }
            }

            const lastWp = waypoints[waypoints.length - 1];
            if (lastWp) {
                await this.sdk.sendWalk(lastWp.x, lastWp.z, true);
                await this.waitForMovementComplete(lastWp.x, lastWp.z, 3);
            }

            const afterState = this.sdk.getState();
            const afterX = afterState?.player?.worldX ?? currentX;
            const afterZ = afterState?.player?.worldZ ?? currentZ;
            const newDistToGoal = Math.sqrt(Math.pow(x - afterX, 2) + Math.pow(z - afterZ, 2));

            if (newDistToGoal <= tolerance) {
                return { success: true, message: `Arrived at (${afterX}, ${afterZ})` };
            }

            const progressMade = distToGoal - newDistToGoal;
            if (progressMade < 5) {
                stuckCount++;
                if (stuckCount >= 3) {
                    return { success: false, message: `Stuck at (${afterX}, ${afterZ}) - cannot reach (${x}, ${z})` };
                }
            } else {
                stuckCount = 0;
            }
        }

        const finalState = this.sdk.getState();
        const finalX = finalState?.player?.worldX ?? startX;
        const finalZ = finalState?.player?.worldZ ?? startZ;
        const finalDist = Math.sqrt(Math.pow(x - finalX, 2) + Math.pow(z - finalZ, 2));

        return {
            success: finalDist <= tolerance,
            message: finalDist <= tolerance
                ? `Arrived at (${finalX}, ${finalZ})`
                : `Could not reach (${x}, ${z}) - stopped at (${finalX}, ${finalZ})`
        };
    }

    // ============ Porcelain: Shop Actions ============

    async closeShop(timeout: number = 5000): Promise<ActionResult> {
        const state = this.sdk.getState();
        if (!state?.shop.isOpen && !state?.interface?.isOpen) {
            return { success: true, message: 'Shop already closed' };
        }

        await this.sdk.sendCloseShop();

        try {
            await this.sdk.waitForCondition(s => {
                const shopClosed = !s.shop.isOpen;
                const interfaceClosed = !s.interface?.isOpen;
                return shopClosed && interfaceClosed;
            }, timeout);

            return { success: true, message: 'Shop closed' };
        } catch {
            await this.sdk.sendCloseShop();
            await new Promise(resolve => setTimeout(resolve, 500));
            const finalState = this.sdk.getState();

            if (!finalState?.shop.isOpen && !finalState?.interface?.isOpen) {
                return { success: true, message: 'Shop closed (second attempt)' };
            }

            return {
                success: false,
                message: `Shop close timeout - shop.isOpen=${finalState?.shop.isOpen}, interface.isOpen=${finalState?.interface?.isOpen}`
            };
        }
    }

    async openShop(target: NearbyNpc | string | RegExp = /shop\s*keeper/i): Promise<ActionResult> {
        const npc = this.resolveNpc(target);
        if (!npc) {
            return { success: false, message: 'Shopkeeper not found' };
        }

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

    async buyFromShop(target: ShopItem | string | RegExp, amount: number = 1): Promise<ShopResult> {
        const shop = this.sdk.getState()?.shop;
        if (!shop?.isOpen) {
            return { success: false, message: 'Shop is not open' };
        }

        const shopItem = this.resolveShopItem(target, shop.shopItems);
        if (!shopItem) {
            return { success: false, message: `Item not found in shop: ${target}` };
        }

        const invBefore = this.sdk.getInventory();
        const hadItemBefore = invBefore.find(i => i.id === shopItem.id);
        const countBefore = hadItemBefore?.count ?? 0;

        const result = await this.sdk.sendShopBuy(shopItem.slot, amount);
        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            await this.sdk.waitForCondition(state => {
                const item = state.inventory.find(i => i.id === shopItem.id);
                if (!item) return false;
                return item.count > countBefore;
            }, 5000);

            const boughtItem = this.sdk.getInventory().find(i => i.id === shopItem.id);
            return { success: true, item: boughtItem, message: `Bought ${shopItem.name} x${amount}` };
        } catch {
            return { success: false, message: `Failed to buy ${shopItem.name} (no coins or out of stock?)` };
        }
    }

    async sellToShop(target: InventoryItem | ShopItem | string | RegExp, amount: SellAmount = 1): Promise<ShopSellResult> {
        const shop = this.sdk.getState()?.shop;
        if (!shop?.isOpen) {
            return { success: false, message: 'Shop is not open' };
        }

        const sellItem = this.resolveShopItem(target, shop.playerItems);
        if (!sellItem) {
            return { success: false, message: `Item not found to sell: ${target}` };
        }

        const startTick = this.sdk.getState()?.tick || 0;

        if (amount === 'all') {
            return this.sellAllToShop(sellItem, startTick);
        }

        const validAmount = [1, 5, 10].includes(amount) ? amount : 1;

        const result = await this.sdk.sendShopSell(sellItem.slot, validAmount);
        if (!result.success) {
            return { success: false, message: result.message };
        }

        const getTotalCount = (playerItems: typeof shop.playerItems) =>
            playerItems.filter(i => i.id === sellItem.id).reduce((sum, i) => sum + i.count, 0);
        const totalCountBefore = getTotalCount(shop.playerItems);

        try {
            const finalState = await this.sdk.waitForCondition(state => {
                for (const msg of state.gameMessages) {
                    if (msg.tick > startTick) {
                        const text = msg.text.toLowerCase();
                        if (text.includes("can't sell this item")) {
                            return true;
                        }
                    }
                }

                const totalCountNow = getTotalCount(state.shop.playerItems);
                return totalCountNow < totalCountBefore;
            }, 5000);

            for (const msg of finalState.gameMessages) {
                if (msg.tick > startTick) {
                    const text = msg.text.toLowerCase();
                    if (text.includes("can't sell this item to this shop")) {
                        return { success: false, message: `Shop doesn't buy ${sellItem.name}`, rejected: true };
                    }
                    if (text.includes("can't sell this item to a shop")) {
                        return { success: false, message: `Cannot sell ${sellItem.name} to any shop`, rejected: true };
                    }
                    if (text.includes("can't sell this item")) {
                        return { success: false, message: `${sellItem.name} is not tradeable`, rejected: true };
                    }
                }
            }

            const totalCountAfter = getTotalCount(finalState.shop.playerItems);
            const amountSold = totalCountBefore - totalCountAfter;

            return { success: true, message: `Sold ${sellItem.name} x${amountSold}`, amountSold };
        } catch {
            return { success: false, message: `Failed to sell ${sellItem.name} (timeout)` };
        }
    }

    private async sellAllToShop(sellItem: ShopItem, startTick: number): Promise<ShopSellResult> {
        let totalSold = 0;

        const getTotalCount = (playerItems: ShopItem[]) => {
            return playerItems.filter(i => i.id === sellItem.id).reduce((sum, i) => sum + i.count, 0);
        };

        while (true) {
            const state = this.sdk.getState();
            if (!state?.shop.isOpen) {
                break;
            }

            const currentItem = state.shop.playerItems.find(i => i.id === sellItem.id);
            if (!currentItem || currentItem.count === 0) {
                break;
            }

            const totalCountBefore = getTotalCount(state.shop.playerItems);
            const sellAmount = Math.min(10, currentItem.count);
            const currentSlot = currentItem.slot;

            const result = await this.sdk.sendShopSell(currentSlot, sellAmount);
            if (!result.success) {
                break;
            }

            try {
                const finalState = await this.sdk.waitForCondition(s => {
                    for (const msg of s.gameMessages) {
                        if (msg.tick > startTick) {
                            if (msg.text.toLowerCase().includes("can't sell this item")) {
                                return true;
                            }
                        }
                    }

                    const totalCountNow = getTotalCount(s.shop.playerItems);
                    return totalCountNow < totalCountBefore;
                }, 3000);

                for (const msg of finalState.gameMessages) {
                    if (msg.tick > startTick) {
                        const text = msg.text.toLowerCase();
                        if (text.includes("can't sell this item to this shop")) {
                            return {
                                success: totalSold > 0,
                                message: totalSold > 0
                                    ? `Sold ${sellItem.name} x${totalSold}, then shop stopped buying`
                                    : `Shop doesn't buy ${sellItem.name}`,
                                amountSold: totalSold,
                                rejected: true
                            };
                        }
                        if (text.includes("can't sell this item")) {
                            return {
                                success: false,
                                message: `${sellItem.name} cannot be sold`,
                                amountSold: totalSold,
                                rejected: true
                            };
                        }
                    }
                }

                const totalCountAfter = getTotalCount(finalState.shop.playerItems);
                const soldThisRound = totalCountBefore - totalCountAfter;
                totalSold += soldThisRound;

                if (soldThisRound === 0) {
                    break;
                }

            } catch {
                break;
            }
        }

        if (totalSold === 0) {
            return { success: false, message: `Failed to sell any ${sellItem.name}` };
        }

        return { success: true, message: `Sold ${sellItem.name} x${totalSold}`, amountSold: totalSold };
    }

    // ============ Porcelain: Bank Actions ============

    async openBank(timeout: number = 10000): Promise<OpenBankResult> {
        const state = this.sdk.getState();
        if (state?.interface?.isOpen) {
            return { success: true, message: 'Bank already open' };
        }

        await this.dismissBlockingUI();

        const banker = this.sdk.findNearbyNpc(/banker/i);
        const bankBooth = this.sdk.findNearbyLoc(/bank booth|bank chest/i);

        let interactSuccess = false;

        if (banker) {
            const bankOpt = banker.optionsWithIndex.find(o => /^bank$/i.test(o.text));
            if (bankOpt) {
                await this.sdk.sendInteractNpc(banker.index, bankOpt.opIndex);
                interactSuccess = true;
            }
        }

        if (!interactSuccess && bankBooth) {
            const bankOpt = bankBooth.optionsWithIndex.find(o => /^bank$/i.test(o.text)) ||
                           bankBooth.optionsWithIndex.find(o => /use/i.test(o.text));
            if (bankOpt) {
                await this.sdk.sendInteractLoc(bankBooth.x, bankBooth.z, bankBooth.id, bankOpt.opIndex);
                interactSuccess = true;
            }
        }

        if (!interactSuccess) {
            return { success: false, message: 'No banker NPC or bank booth found nearby', reason: 'no_bank_found' };
        }

        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                await this.sdk.waitForCondition(s =>
                    s.interface?.isOpen === true || s.dialog?.isOpen === true,
                    Math.min(2000, timeout - (Date.now() - startTime))
                );

                const currentState = this.sdk.getState();

                if (currentState?.interface?.isOpen) {
                    return { success: true, message: `Bank opened (interfaceId: ${currentState.interface.interfaceId})` };
                }

                if (currentState?.dialog?.isOpen) {
                    const opt = currentState.dialog.options?.[0];
                    await this.sdk.sendClickDialog(opt?.index ?? 0);
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                }
            } catch {
                // Timeout on waitForCondition, loop will continue or exit
            }
        }

        const finalState = this.sdk.getState();
        if (finalState?.interface?.isOpen) {
            return { success: true, message: `Bank opened (interfaceId: ${finalState.interface.interfaceId})` };
        }

        return { success: false, message: 'Timeout waiting for bank interface to open', reason: 'timeout' };
    }

    async closeBank(timeout: number = 5000): Promise<ActionResult> {
        const state = this.sdk.getState();
        if (!state?.interface?.isOpen) {
            return { success: true, message: 'Bank already closed' };
        }

        await this.sdk.sendCloseModal();

        try {
            await this.sdk.waitForCondition(s => !s.interface?.isOpen, timeout);
            return { success: true, message: 'Bank closed' };
        } catch {
            await this.sdk.sendCloseModal();
            await new Promise(resolve => setTimeout(resolve, 500));

            const finalState = this.sdk.getState();
            if (!finalState?.interface?.isOpen) {
                return { success: true, message: 'Bank closed (second attempt)' };
            }

            return { success: false, message: `Bank close timeout - interface.isOpen=${finalState?.interface?.isOpen}` };
        }
    }

    async depositItem(target: InventoryItem | string | RegExp, amount: number = -1): Promise<BankDepositResult> {
        const state = this.sdk.getState();
        if (!state?.interface?.isOpen) {
            return { success: false, message: 'Bank is not open', reason: 'bank_not_open' };
        }

        const item = this.resolveInventoryItem(target, /./);
        if (!item) {
            return { success: false, message: `Item not found in inventory: ${target}`, reason: 'item_not_found' };
        }

        const countBefore = state.inventory.filter(i => i.id === item.id).reduce((sum, i) => sum + i.count, 0);

        await this.sdk.sendBankDeposit(item.slot, amount);

        try {
            await this.sdk.waitForCondition(s => {
                const countNow = s.inventory.filter(i => i.id === item.id).reduce((sum, i) => sum + i.count, 0);
                return countNow < countBefore;
            }, 5000);

            const finalState = this.sdk.getState();
            const countAfter = finalState?.inventory.filter(i => i.id === item.id).reduce((sum, i) => sum + i.count, 0) ?? 0;
            const amountDeposited = countBefore - countAfter;

            return { success: true, message: `Deposited ${item.name} x${amountDeposited}`, amountDeposited };
        } catch {
            return { success: false, message: `Timeout waiting for ${item.name} to be deposited`, reason: 'timeout' };
        }
    }

    async withdrawItem(bankSlot: number, amount: number = 1): Promise<BankWithdrawResult> {
        const state = this.sdk.getState();
        if (!state?.interface?.isOpen) {
            return { success: false, message: 'Bank is not open', reason: 'bank_not_open' };
        }

        const invCountBefore = state.inventory.length;

        await this.sdk.sendBankWithdraw(bankSlot, amount);

        try {
            await this.sdk.waitForCondition(s => {
                return s.inventory.length > invCountBefore ||
                       s.inventory.some(i => {
                           const before = state.inventory.find(bi => bi.slot === i.slot);
                           return before && i.count > before.count;
                       });
            }, 5000);

            const finalInv = this.sdk.getInventory();
            const newItem = finalInv.find(i => {
                const before = state.inventory.find(bi => bi.slot === i.slot);
                return !before || i.count > before.count;
            });

            return { success: true, message: `Withdrew item from bank slot ${bankSlot}`, item: newItem };
        } catch {
            return { success: false, message: `Timeout waiting for item to be withdrawn`, reason: 'timeout' };
        }
    }

    // ============ Porcelain: Equipment & Combat ============

    async equipItem(target: InventoryItem | string | RegExp): Promise<EquipResult> {
        const item = this.resolveInventoryItem(target, /./);
        if (!item) {
            return { success: false, message: `Item not found: ${target}` };
        }

        const equipOpt = item.optionsWithIndex.find(o => /wield|wear|equip/i.test(o.text));
        if (!equipOpt) {
            return { success: false, message: `No equip option on ${item.name}` };
        }

        const result = await this.sdk.sendUseItem(item.slot, equipOpt.opIndex);
        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            await this.sdk.waitForCondition(state =>
                !state.inventory.find(i => i.slot === item.slot && i.id === item.id),
                5000
            );
            return { success: true, message: `Equipped ${item.name}` };
        } catch {
            return { success: false, message: `Failed to equip ${item.name}` };
        }
    }

    async unequipItem(target: InventoryItem | string | RegExp): Promise<UnequipResult> {
        let item: InventoryItem | null = null;
        if (typeof target === 'object' && 'slot' in target) {
            item = target;
        } else {
            item = this.sdk.findEquipmentItem(target);
        }

        if (!item) {
            return { success: false, message: `Item not found in equipment: ${target}` };
        }

        const invCountBefore = this.sdk.getInventory().length;
        const result = await this.sdk.sendUseEquipmentItem(item.slot, 1);
        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            await this.sdk.waitForCondition(state =>
                state.inventory.length > invCountBefore ||
                state.inventory.some(i => i.id === item!.id),
                5000
            );

            const unequippedItem = this.sdk.findInventoryItem(new RegExp(item.name, 'i'));
            return { success: true, message: `Unequipped ${item.name}`, item: unequippedItem || undefined };
        } catch {
            return { success: false, message: `Failed to unequip ${item.name}` };
        }
    }

    getEquipment(): InventoryItem[] {
        return this.sdk.getEquipment();
    }

    findEquippedItem(pattern: string | RegExp): InventoryItem | null {
        return this.sdk.findEquipmentItem(pattern);
    }

    async eatFood(target: InventoryItem | string | RegExp): Promise<EatResult> {
        const food = this.resolveInventoryItem(target, /./);
        if (!food) {
            return { success: false, hpGained: 0, message: `Food not found: ${target}` };
        }

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
            await this.sdk.waitForCondition(state => {
                const hp = state.skills.find(s => s.name === 'Hitpoints')?.level ?? 10;
                const foodCount = state.inventory.filter(i => i.id === food.id).length;
                return hp > hpBefore || foodCount < foodCountBefore;
            }, 5000);

            const hpAfter = this.sdk.getSkill('Hitpoints')?.level ?? 10;
            return { success: true, hpGained: hpAfter - hpBefore, message: `Ate ${food.name}` };
        } catch {
            return { success: false, hpGained: 0, message: `Failed to eat ${food.name}` };
        }
    }

    async attackNpc(target: NearbyNpc | string | RegExp, timeout: number = 5000): Promise<AttackResult> {
        const npc = this.resolveNpc(target);
        if (!npc) {
            return { success: false, message: `NPC not found: ${target}`, reason: 'npc_not_found' };
        }

        const attackOpt = npc.optionsWithIndex.find(o => /attack/i.test(o.text));
        if (!attackOpt) {
            return { success: false, message: `No attack option on ${npc.name}`, reason: 'no_attack_option' };
        }

        const startTick = this.sdk.getState()?.tick || 0;
        const result = await this.sdk.sendInteractNpc(npc.index, attackOpt.opIndex);
        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            const finalState = await this.sdk.waitForCondition(state => {
                for (const msg of state.gameMessages) {
                    if (msg.tick > startTick) {
                        const text = msg.text.toLowerCase();
                        if (text.includes("can't reach") || text.includes("cannot reach")) {
                            return true;
                        }
                        if (text.includes("someone else is fighting") || text.includes("already under attack")) {
                            return true;
                        }
                    }
                }

                const targetNpc = state.nearbyNpcs.find(n => n.index === npc.index);
                if (!targetNpc) {
                    return true;
                }

                if (targetNpc.distance <= 2) {
                    return true;
                }

                return false;
            }, timeout);

            for (const msg of finalState.gameMessages) {
                if (msg.tick > startTick) {
                    const text = msg.text.toLowerCase();
                    if (text.includes("can't reach") || text.includes("cannot reach")) {
                        return { success: false, message: `Cannot reach ${npc.name} - obstacle in the way`, reason: 'out_of_reach' };
                    }
                    if (text.includes("someone else is fighting") || text.includes("already under attack")) {
                        return { success: false, message: `${npc.name} is already in combat`, reason: 'already_in_combat' };
                    }
                }
            }

            return { success: true, message: `Attacking ${npc.name}` };
        } catch {
            return { success: false, message: `Timeout waiting to attack ${npc.name}`, reason: 'timeout' };
        }
    }

    async castSpellOnNpc(target: NearbyNpc | string | RegExp, spellComponent: number, timeout: number = 3000): Promise<CastSpellResult> {
        const npc = this.resolveNpc(target);
        if (!npc) {
            return { success: false, message: `NPC not found: ${target}`, reason: 'npc_not_found' };
        }

        const startState = this.sdk.getState();
        if (!startState) {
            return { success: false, message: 'No game state available' };
        }
        const startTick = startState.tick;
        const startMagicXp = startState.skills.find(s => s.name === 'Magic')?.experience ?? 0;

        const result = await this.sdk.sendSpellOnNpc(npc.index, spellComponent);
        if (!result.success) {
            return { success: false, message: result.message };
        }

        try {
            const finalState = await this.sdk.waitForCondition(state => {
                for (const msg of state.gameMessages) {
                    if (msg.tick > startTick) {
                        const text = msg.text.toLowerCase();
                        if (text.includes("can't reach") || text.includes("cannot reach")) {
                            return true;
                        }
                        if (text.includes("do not have enough") || text.includes("don't have enough")) {
                            return true;
                        }
                    }
                }

                const currentMagicXp = state.skills.find(s => s.name === 'Magic')?.experience ?? 0;
                if (currentMagicXp > startMagicXp) {
                    return true;
                }

                return false;
            }, timeout);

            for (const msg of finalState.gameMessages) {
                if (msg.tick > startTick) {
                    const text = msg.text.toLowerCase();
                    if (text.includes("can't reach") || text.includes("cannot reach")) {
                        return { success: false, message: `Cannot reach ${npc.name} - obstacle in the way`, reason: 'out_of_reach' };
                    }
                    if (text.includes("do not have enough") || text.includes("don't have enough")) {
                        return { success: false, message: `Not enough runes to cast spell`, reason: 'no_runes' };
                    }
                }
            }

            const finalMagicXp = finalState.skills.find(s => s.name === 'Magic')?.experience ?? 0;
            const xpGained = finalMagicXp - startMagicXp;
            if (xpGained > 0) {
                return { success: true, message: `Hit ${npc.name} for ${xpGained} Magic XP`, hit: true, xpGained };
            }

            return { success: true, message: `Splashed on ${npc.name}`, hit: false, xpGained: 0 };
        } catch {
            return { success: true, message: `Splashed on ${npc.name} (timeout)`, hit: false, xpGained: 0 };
        }
    }

    // ============ Porcelain: Condition Helpers ============

    async waitForSkillLevel(skillName: string, targetLevel: number, timeout: number = 60000): Promise<SkillState> {
        const state = await this.sdk.waitForCondition(s => {
            const skill = s.skills.find(sk => sk.name.toLowerCase() === skillName.toLowerCase());
            return skill !== undefined && skill.baseLevel >= targetLevel;
        }, timeout);

        return state.skills.find(s => s.name.toLowerCase() === skillName.toLowerCase())!;
    }

    async waitForInventoryItem(pattern: string | RegExp, timeout: number = 30000): Promise<InventoryItem> {
        const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;

        const state = await this.sdk.waitForCondition(s =>
            s.inventory.some(i => regex.test(i.name)),
            timeout
        );

        return state.inventory.find(i => regex.test(i.name))!;
    }

    async waitForDialogClose(timeout: number = 30000): Promise<void> {
        await this.sdk.waitForCondition(s => !s.dialog.isOpen, timeout);
    }

    async waitForIdle(timeout: number = 10000): Promise<void> {
        const initialState = this.sdk.getState();
        if (!initialState?.player) {
            throw new Error('No player state');
        }

        const initialX = initialState.player.x;
        const initialZ = initialState.player.z;

        await this.sdk.waitForStateChange(timeout);

        await this.sdk.waitForCondition(state => {
            if (!state.player) return false;
            return state.player.x === initialX && state.player.z === initialZ;
        }, timeout);
    }

    // ============ Porcelain: Sequences ============

    async navigateDialog(choices: (number | string | RegExp)[]): Promise<void> {
        for (const choice of choices) {
            const dialog = this.sdk.getDialog();
            let optionIndex: number;

            if (typeof choice === 'number') {
                optionIndex = choice;
            } else {
                const regex = typeof choice === 'string' ? new RegExp(choice, 'i') : choice;
                const match = dialog?.options.find(o => regex.test(o.text));
                optionIndex = match?.index ?? 0;
            }

            await this.sdk.sendClickDialog(optionIndex);
            await new Promise(r => setTimeout(r, 600));
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
        if (typeof target === 'object' && 'id' in target && 'name' in target) {
            return items.find(i => i.id === target.id) ?? null;
        }
        const regex = typeof target === 'string' ? new RegExp(target, 'i') : target;
        return items.find(i => regex.test(i.name)) ?? null;
    }
}

// Re-export for convenience
export { BotSDK } from './index';
export * from './types';
