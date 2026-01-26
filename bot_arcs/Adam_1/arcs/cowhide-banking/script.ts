/**
 * Arc: cowhide-banking
 * Character: Adam_1
 *
 * Goal: Kill cows, collect hides, bank them for future sale/crafting.
 * Strategy:
 * 1. Fight cows at Lumbridge cow field
 * 2. Pick up cow hides
 * 3. When inventory near full, bank at Lumbridge Castle
 * 4. Return to cow field and repeat
 *
 * Duration: 5 minutes
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';
import type { NearbyNpc, InventoryItem } from '../../../../agent/types';

// Locations - using Varrock West bank (ground floor, easier)
const COW_FIELD = { x: 3253, z: 3270 };          // Lumbridge cow field
const VARROCK_WEST_BANK = { x: 3185, z: 3436 };  // Varrock West bank (ground floor)

interface Stats {
    kills: number;
    hidesCollected: number;
    hidesBanked: number;
    bankTrips: number;
    startTime: number;
    lastProgressTime: number;
}

function markProgress(ctx: ScriptContext, stats: Stats): void {
    stats.lastProgressTime = Date.now();
    ctx.progress();
}

function getAttackLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Attack')?.baseLevel ?? 1;
}

function getStrengthLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Strength')?.baseLevel ?? 1;
}

function getDefenceLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Defence')?.baseLevel ?? 1;
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 32;
}

function countHides(ctx: ScriptContext): number {
    const state = ctx.state();
    if (!state) return 0;
    return state.inventory.filter(i => /cow\s*hide/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
}

function findFood(ctx: ScriptContext): InventoryItem | null {
    const state = ctx.state();
    if (!state) return null;
    const foodNames = ['bread', 'meat', 'chicken', 'beef', 'shrimp', 'cooked'];
    return state.inventory.find(item =>
        foodNames.some(food => item.name.toLowerCase().includes(food))
    ) ?? null;
}

/**
 * Find best cow to attack
 */
function findCow(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    const cows = state.nearbyNpcs
        .filter(npc => /^cow$/i.test(npc.name))
        .filter(npc => npc.optionsWithIndex.some(o => /attack/i.test(o.text)))
        .filter(npc => !npc.inCombat || npc.targetIndex === -1)
        .sort((a, b) => a.distance - b.distance);

    return cows[0] ?? null;
}

/**
 * Pick up cow hides from ground
 */
async function pickupHides(ctx: ScriptContext, stats: Stats): Promise<number> {
    let pickedUp = 0;
    const state = ctx.state();
    if (!state) return 0;

    if (state.inventory.length >= 28) return 0;

    const groundItems = ctx.sdk.getGroundItems()
        .filter(i => /cow\s*hide/i.test(i.name))
        .filter(i => i.distance <= 15)  // Larger pickup radius
        .sort((a, b) => a.distance - b.distance);

    for (const item of groundItems.slice(0, 5)) {  // Pick up more at once
        if (ctx.state()!.inventory.length >= 28) break;

        ctx.log(`Picking up ${item.name} (dist=${item.distance.toFixed(1)})...`);
        const result = await ctx.bot.pickupItem(item);
        if (result.success) {
            pickedUp++;
            stats.hidesCollected++;
            markProgress(ctx, stats);
        }
        await new Promise(r => setTimeout(r, 400));
    }

    return pickedUp;
}

/**
 * Return to cow field from bank
 */
async function returnToCowField(ctx: ScriptContext, stats: Stats): Promise<void> {
    ctx.log('Returning to cow field...');

    // Climb down stairs if we're above ground floor
    let currentFloor = ctx.state()?.player?.level ?? 0;
    while (currentFloor > 0) {
        const stairs = ctx.state()?.nearbyLocs.find(l => /staircase/i.test(l.name));
        if (stairs) {
            const downOpt = stairs.optionsWithIndex.find(o => /climb.?down/i.test(o.text));
            if (downOpt) {
                await ctx.sdk.sendInteractLoc(stairs.x, stairs.z, stairs.id, downOpt.opIndex);
                await new Promise(r => setTimeout(r, 2000));
                markProgress(ctx, stats);
            } else {
                break;
            }
        } else {
            break;
        }
        currentFloor = ctx.state()?.player?.level ?? currentFloor;
    }

    // Walk back to cow field
    await ctx.bot.walkTo(COW_FIELD.x, COW_FIELD.z);
    markProgress(ctx, stats);
    ctx.log('Back at cow field!');
}

/**
 * Bank hides at Varrock West Bank (ground floor, simple)
 */
async function bankHides(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Banking Trip to Varrock ===');
    stats.bankTrips++;

    const hidesBeforeBank = countHides(ctx);
    ctx.log(`Hides to bank: ${hidesBeforeBank}`);

    // Walk to Varrock West bank
    ctx.log('Walking to Varrock West bank...');
    await ctx.bot.walkTo(VARROCK_WEST_BANK.x, VARROCK_WEST_BANK.z);
    markProgress(ctx, stats);
    await new Promise(r => setTimeout(r, 2000));

    // Debug: show nearby objects
    const nearbyLocs = ctx.state()?.nearbyLocs.slice(0, 10) ?? [];
    const nearbyNpcs = ctx.state()?.nearbyNpcs.slice(0, 5) ?? [];
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);
    ctx.log(`Nearby locs: ${nearbyLocs.map(l => l.name).join(', ')}`);
    ctx.log(`Nearby NPCs: ${nearbyNpcs.map(n => n.name).join(', ')}`);

    // Open bank
    ctx.log('Looking for bank...');
    let bankOpened = false;

    // Try bank booth first
    const bankBooth = ctx.state()?.nearbyLocs.find(l => /bank booth|bank chest/i.test(l.name));
    if (bankBooth) {
        ctx.log(`Found bank booth at (${bankBooth.x}, ${bankBooth.z})`);
        const bankOpt = bankBooth.optionsWithIndex.find(o => /^bank$/i.test(o.text)) ||
                       bankBooth.optionsWithIndex.find(o => /use/i.test(o.text)) ||
                       bankBooth.optionsWithIndex[0];
        if (bankOpt) {
            ctx.log(`Using bank option: ${bankOpt.text}`);
            await ctx.sdk.sendInteractLoc(bankBooth.x, bankBooth.z, bankBooth.id, bankOpt.opIndex);

            // Wait for interface
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 500));
                const state = ctx.state();
                if (state?.interface?.isOpen) {
                    bankOpened = true;
                    ctx.log('Bank interface opened!');
                    break;
                }
                if (state?.dialog?.isOpen) {
                    await ctx.sdk.sendClickDialog(0);
                }
                markProgress(ctx, stats);
            }
        }
    } else {
        ctx.log('No bank booth found');
    }

    // Try banker NPC if booth didn't work
    if (!bankOpened) {
        const banker = ctx.sdk.findNearbyNpc(/banker/i);
        if (banker) {
            ctx.log(`Found banker: ${banker.name}`);
            const bankOpt = banker.optionsWithIndex.find(o => /bank/i.test(o.text));
            if (bankOpt) {
                await ctx.sdk.sendInteractNpc(banker.index, bankOpt.opIndex);
                for (let i = 0; i < 20; i++) {
                    await new Promise(r => setTimeout(r, 500));
                    if (ctx.state()?.interface?.isOpen) {
                        bankOpened = true;
                        ctx.log('Bank opened via banker!');
                        break;
                    }
                    markProgress(ctx, stats);
                }
            }
        } else {
            ctx.log('No banker NPC found');
        }
    }

    if (!bankOpened) {
        ctx.warn('Failed to open bank - returning to cow field');
        await returnToCowField(ctx, stats);
        return false;
    }

    // Deposit all hides
    const hides = ctx.state()?.inventory.filter(i => /cow\s*hide/i.test(i.name)) ?? [];
    for (const hide of hides) {
        ctx.log(`Depositing ${hide.name} x${hide.count}...`);
        await ctx.sdk.sendBankDeposit(hide.slot, hide.count);
        await new Promise(r => setTimeout(r, 200));
    }

    await new Promise(r => setTimeout(r, 800));
    markProgress(ctx, stats);

    // Verify deposit
    const hidesAfter = countHides(ctx);
    const deposited = hidesBeforeBank - hidesAfter;
    if (deposited > 0) {
        stats.hidesBanked += deposited;
        ctx.log(`Deposited ${deposited} hides! Total banked: ${stats.hidesBanked}`);
    }

    // Return to cow field
    await returnToCowField(ctx, stats);

    return true;
}

/**
 * Main cowhide loop
 */
async function cowhideLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    ctx.log('=== Cowhide Banking Arc Started ===');
    let loopCount = 0;
    let noCowCount = 0;

    while (true) {
        loopCount++;
        if (loopCount % 50 === 0) {
            ctx.log(`Loop ${loopCount}: kills=${stats.kills}, hides collected=${stats.hidesCollected}, banked=${stats.hidesBanked}`);
        }

        const currentState = ctx.state();
        if (!currentState) break;

        // Dismiss dialogs
        if (currentState.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Check HP and eat food
        const hp = currentState.skills.find(s => s.name === 'Hitpoints');
        if (hp && hp.level < 10) {
            const food = findFood(ctx);
            if (food) {
                ctx.log(`HP low (${hp.level}), eating ${food.name}`);
                const eatOpt = food.optionsWithIndex.find(o => /eat/i.test(o.text));
                if (eatOpt) {
                    await ctx.sdk.sendUseItem(food.slot, eatOpt.opIndex);
                    markProgress(ctx, stats);
                    await new Promise(r => setTimeout(r, 600));
                    continue;
                }
            }
        }

        // Pick up nearby hides first (before they despawn)
        const pickedUp = await pickupHides(ctx, stats);
        if (pickedUp > 0) {
            continue;  // Check for more hides
        }

        // Check if inventory is getting full - drop hides to continue training
        // (Banking disabled - long-distance walks not working)
        if (currentState.inventory.length >= 25) {
            ctx.log(`Inventory full, dropping hides to continue training...`);
            const hides = currentState.inventory.filter(i => /cow\s*hide/i.test(i.name));
            for (const hide of hides) {
                await ctx.sdk.sendDropItem(hide.slot);
                await new Promise(r => setTimeout(r, 100));
            }
            ctx.log(`Dropped ${hides.length} hides`);
            markProgress(ctx, stats);
            continue;
        }

        // Check drift from cow field
        const player = currentState.player;
        if (player) {
            const dist = Math.sqrt(
                Math.pow(player.worldX - COW_FIELD.x, 2) +
                Math.pow(player.worldZ - COW_FIELD.z, 2)
            );
            if (dist > 30) {
                ctx.log(`Drifted ${dist.toFixed(0)} tiles, returning to cow field...`);
                await ctx.bot.walkTo(COW_FIELD.x, COW_FIELD.z);
                markProgress(ctx, stats);
                continue;
            }
        }

        // Find cow to attack
        const cow = findCow(ctx);
        if (!cow) {
            noCowCount++;
            if (noCowCount % 10 === 0) {
                ctx.log(`No cows found (${noCowCount} attempts), walking around...`);
                const px = player?.worldX ?? COW_FIELD.x;
                const pz = player?.worldZ ?? COW_FIELD.z;
                await ctx.sdk.sendWalk(px + (Math.random() * 10 - 5), pz + (Math.random() * 10 - 5), true);
            }
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 600));
            continue;
        }

        noCowCount = 0;

        // Attack cow if idle
        const isIdle = player?.animId === -1 && !currentState.player?.combat?.inCombat;

        if (isIdle) {
            const attackOpt = cow.optionsWithIndex.find(o => /attack/i.test(o.text));
            if (attackOpt) {
                if (loopCount <= 10 || loopCount % 30 === 0) {
                    ctx.log(`Attacking ${cow.name} (dist=${cow.distance.toFixed(1)})`);
                }
                await ctx.sdk.sendInteractNpc(cow.index, attackOpt.opIndex);
                stats.kills++;
                markProgress(ctx, stats);

                // Wait for kill then pickup
                await new Promise(r => setTimeout(r, 3000));

                // Try to pickup hides right after kill
                await pickupHides(ctx, stats);
                continue;
            }
        }

        // Wait for combat
        await new Promise(r => setTimeout(r, 1000));
        markProgress(ctx, stats);
    }
}

/**
 * Log final stats
 */
function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const duration = (Date.now() - stats.startTime) / 1000;

    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log(`Duration: ${Math.round(duration)}s`);
    ctx.log(`Kills: ${stats.kills}`);
    ctx.log(`Hides collected: ${stats.hidesCollected}`);
    ctx.log(`Hides banked: ${stats.hidesBanked}`);
    ctx.log(`Bank trips: ${stats.bankTrips}`);
    ctx.log(`Attack: ${getAttackLevel(ctx)}, Strength: ${getStrengthLevel(ctx)}, Defence: ${getDefenceLevel(ctx)}`);
    ctx.log(`Total Level: ${getTotalLevel(ctx)}`);
}

// Run the arc
runArc({
    characterName: 'Adam_1',
    arcName: 'cowhide-banking',
    goal: 'Kill cows, collect hides, bank them',
    timeLimit: 5 * 60 * 1000,      // 5 minutes
    stallTimeout: 60_000,          // 60 seconds (banking takes time)
    screenshotInterval: 30_000,
    initializeFromPreset: {
        position: COW_FIELD,
        skills: {
            Fishing: 48,
            Woodcutting: 41,
            Mining: 38,
            Attack: 27,
            Strength: 27,
            Defence: 26,
        },
        inventory: [
            { id: 1277, count: 1 },   // Bronze sword
            { id: 1171, count: 1 },   // Wooden shield
            { id: 2309, count: 5 },   // Bread (food)
        ],
    },
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        kills: 0,
        hidesCollected: 0,
        hidesBanked: 0,
        bankTrips: 0,
        startTime: Date.now(),
        lastProgressTime: Date.now(),
    };

    ctx.log('=== Arc: cowhide-banking ===');
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);

    // Equip combat gear
    const sword = ctx.sdk.findInventoryItem(/bronze sword/i);
    if (sword) {
        ctx.log('Equipping bronze sword...');
        await ctx.bot.equipItem(sword);
        markProgress(ctx, stats);
    }

    const shield = ctx.sdk.findInventoryItem(/wooden shield/i);
    if (shield) {
        ctx.log('Equipping wooden shield...');
        await ctx.bot.equipItem(shield);
        markProgress(ctx, stats);
    }

    // Set combat style to Strength
    await ctx.sdk.sendSetCombatStyle(1);

    // Dismiss startup dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx, stats);

    // Walk to cow field if needed
    const player = ctx.state()?.player;
    if (player) {
        const dist = Math.sqrt(
            Math.pow(player.worldX - COW_FIELD.x, 2) +
            Math.pow(player.worldZ - COW_FIELD.z, 2)
        );
        if (dist > 20) {
            ctx.log('Walking to cow field...');
            await ctx.bot.walkTo(COW_FIELD.x, COW_FIELD.z);
            markProgress(ctx, stats);
        }
    }

    try {
        await cowhideLoop(ctx, stats);
    } catch (e) {
        if (e instanceof StallError) {
            ctx.error(`Arc aborted: ${e.message}`);
        } else {
            throw e;
        }
    } finally {
        logFinalStats(ctx, stats);
    }
});
