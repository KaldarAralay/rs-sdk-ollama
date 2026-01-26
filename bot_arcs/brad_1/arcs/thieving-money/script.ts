/**
 * Arc: thieving-money
 * Character: brad_1
 *
 * Goal: Make money by pickpocketing men in Lumbridge
 * Strategy:
 * 1. Walk to Lumbridge Castle (where men spawn)
 * 2. Pickpocket men → get 3 GP each
 * 3. Bank at Draynor when 200+ GP
 * 4. Continue until 2000+ GP banked
 *
 * Duration: 10 minutes
 */

import { runArc, StallError } from '../../../arc-runner.ts';
import type { ScriptContext } from '../../../arc-runner.ts';
import type { NearbyNpc } from '../../../../agent/types.ts';

// === LOCATIONS ===
const LOCATIONS = {
    LUMBRIDGE_CASTLE: { x: 3222, z: 3218 },  // Inside castle, near men
    DRAYNOR_BANK: { x: 3092, z: 3243 },
};

// Cow field gate is at approximately (3253, 3267)
// Inside cow field: z > 3267
// Outside cow field (south): z < 3267

// Waypoints from OUTSIDE cow field to Lumbridge Castle
const WAYPOINTS_TO_LUMBRIDGE = [
    { x: 3250, z: 3255 },  // Outside gate, south
    { x: 3240, z: 3240 },  // Continue south
    { x: 3230, z: 3230 },  // Continue south-west
    { x: 3222, z: 3218 },  // Lumbridge Castle
];

// Waypoints from Lumbridge to Draynor Bank
const WAYPOINTS_TO_BANK = [
    { x: 3200, z: 3230 },  // West from Lumbridge
    { x: 3170, z: 3240 },  // Continue west
    { x: 3140, z: 3245 },  // Towards Draynor
    { x: 3110, z: 3243 },  // Near Draynor
    { x: 3092, z: 3243 },  // Draynor Bank
];

const WAYPOINTS_FROM_BANK = [
    { x: 3110, z: 3243 },  // East from Draynor
    { x: 3140, z: 3245 },  // Continue east
    { x: 3170, z: 3240 },  // Past swamp
    { x: 3200, z: 3230 },  // Near Lumbridge
    { x: 3222, z: 3218 },  // Lumbridge Castle
];

// === STATS ===
interface Stats {
    pickpocketAttempts: number;
    successfulPickpockets: number;
    gpEarned: number;
    gpBanked: number;
    bankTrips: number;
    stunned: number;
    startGP: number;
    startTime: number;
}

function markProgress(ctx: ScriptContext): void {
    ctx.progress();
}

// === SKILL HELPERS ===
function getSkillLevel(ctx: ScriptContext, name: string): number {
    return ctx.state()?.skills.find(s => s.name === name)?.baseLevel ?? 1;
}

function getGP(ctx: ScriptContext): number {
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

function getHP(ctx: ScriptContext): { current: number; max: number } {
    const hp = ctx.state()?.skills.find(s => s.name === 'Hitpoints');
    return {
        current: hp?.level ?? 10,
        max: hp?.baseLevel ?? 10,
    };
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 0;
}

// === FOOD MANAGEMENT ===
async function eatFoodIfNeeded(ctx: ScriptContext): Promise<boolean> {
    const hp = getHP(ctx);
    // Eat when below 30% HP (thieving can stun and take damage)
    if (hp.current >= hp.max * 0.3) return false;

    const food = ctx.state()?.inventory.find(i =>
        /cooked|bread|shrimp|trout|salmon|lobster|meat|beef/i.test(i.name)
    );

    if (food) {
        const eatOpt = food.optionsWithIndex.find(o => /eat/i.test(o.text));
        if (eatOpt) {
            ctx.log('Eating ' + food.name + ' (HP: ' + hp.current + '/' + hp.max + ')');
            await ctx.sdk.sendUseItem(food.slot, eatOpt.opIndex);
            markProgress(ctx);
            return true;
        }
    }
    return false;
}

// === WALKING ===
// Use sendWalk directly for more reliable walking (short steps, no pathfinder needed)
async function walkToPoint(ctx: ScriptContext, targetX: number, targetZ: number): Promise<boolean> {
    const startPlayer = ctx.state()?.player;
    if (!startPlayer) return false;

    const startDist = Math.sqrt(
        Math.pow(startPlayer.worldX - targetX, 2) +
        Math.pow(startPlayer.worldZ - targetZ, 2)
    );

    // If already close, we're done
    if (startDist < 10) return true;

    // Send walk command
    await ctx.sdk.sendWalk(targetX, targetZ, true);
    markProgress(ctx);

    // Wait to arrive (up to 15 seconds)
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        markProgress(ctx);

        // Dismiss dialogs
        if (ctx.state()?.dialog?.isOpen) {
            await ctx.sdk.sendClickDialog(0);
        }

        const currentPlayer = ctx.state()?.player;
        if (currentPlayer) {
            const dist = Math.sqrt(
                Math.pow(currentPlayer.worldX - targetX, 2) +
                Math.pow(currentPlayer.worldZ - targetZ, 2)
            );
            if (dist < 10) {
                return true;  // Arrived
            }

            // Re-send walk every 5 seconds
            if (i % 10 === 9) {
                await ctx.sdk.sendWalk(targetX, targetZ, true);
            }
        }
    }

    return false;
}

async function walkWaypoints(ctx: ScriptContext, waypoints: {x: number, z: number}[]): Promise<boolean> {
    for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
        const wp = waypoints[wpIdx]!;
        const player = ctx.state()?.player;
        const startPos = player ? `(${player.worldX}, ${player.worldZ})` : '(unknown)';
        ctx.log(`Walking to waypoint ${wpIdx + 1}/${waypoints.length}: ${startPos} -> (${wp.x}, ${wp.z})`);

        const arrived = await walkToPoint(ctx, wp.x, wp.z);
        if (arrived) {
            const currentPlayer = ctx.state()?.player;
            ctx.log(`  Arrived at (${currentPlayer?.worldX}, ${currentPlayer?.worldZ})`);
        } else {
            // Try opening any nearby doors/gates
            await ctx.bot.openDoor(/door|gate/i);
            await new Promise(r => setTimeout(r, 500));
            // Try again
            await walkToPoint(ctx, wp.x, wp.z);
            const finalPlayer = ctx.state()?.player;
            ctx.log(`  After retry: at (${finalPlayer?.worldX}, ${finalPlayer?.worldZ})`);
        }
    }
    return true;
}

// === BANKING ===
async function bankCoins(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Banking GP at Draynor Bank ===');
    stats.bankTrips++;

    const gpBefore = getGP(ctx);
    if (gpBefore < 200) {
        ctx.log(`Only ${gpBefore} GP, not enough to bank yet`);
        return false;
    }

    // Walk to bank
    ctx.log('Walking to Draynor Bank...');
    await walkWaypoints(ctx, WAYPOINTS_TO_BANK);

    // Open bank
    const banker = ctx.state()?.nearbyNpcs.find(n => /banker/i.test(n.name));
    if (!banker) {
        ctx.warn('No banker found!');
        return false;
    }

    const bankOpt = banker.optionsWithIndex?.find(o => /bank/i.test(o.text));
    if (!bankOpt) {
        ctx.warn('No bank option on banker');
        return false;
    }

    await ctx.sdk.sendInteractNpc(banker.index, bankOpt.opIndex);

    // Wait for bank to open
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 400));
        if (ctx.state()?.interface?.isOpen) {
            ctx.log('Bank opened!');
            break;
        }
        markProgress(ctx);
    }

    if (!ctx.state()?.interface?.isOpen) {
        ctx.warn('Bank did not open');
        return false;
    }

    // Deposit coins - use option index 7 for "Deposit-All"
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    if (coins) {
        const depositAmount = coins.count ?? 1;
        ctx.log(`Depositing ${depositAmount} coins from slot ${coins.slot}...`);

        // Try deposit-all first (option index may vary, try common ones)
        // sendBankDeposit(slot, count) - make sure count is correct
        await ctx.sdk.sendBankDeposit(coins.slot, depositAmount);
        await new Promise(r => setTimeout(r, 1000));  // Wait a bit for deposit

        // Check how many coins we have now
        const coinsAfter = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
        const afterCount = coinsAfter?.count ?? 0;
        const deposited = depositAmount - afterCount;

        if (deposited > 0) {
            stats.gpBanked += deposited;
            ctx.log(`Deposited ${deposited} coins! (${afterCount} remaining in inventory)`);
        } else {
            ctx.warn(`Deposit may have failed - still have ${afterCount} coins`);
        }
    }

    // Close bank
    await ctx.bot.closeShop();
    await new Promise(r => setTimeout(r, 300));

    ctx.log(`Banked GP (total banked: ${stats.gpBanked})`);

    // Return to Lumbridge
    ctx.log('Returning to Lumbridge...');
    await walkWaypoints(ctx, WAYPOINTS_FROM_BANK);

    return true;
}

// === THIEVING HELPERS ===
function findMan(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    // Look for men (or women) to pickpocket
    const targets = state.nearbyNpcs
        .filter(npc => /^(man|woman)$/i.test(npc.name))
        .filter(npc => npc.options.some(opt => /pickpocket/i.test(opt)))
        .filter(npc => !npc.inCombat)
        .sort((a, b) => a.distance - b.distance);

    return targets[0] ?? null;
}

async function pickpocket(ctx: ScriptContext, target: NearbyNpc, stats: Stats): Promise<boolean> {
    const gpBefore = getGP(ctx);

    const pickpocketOpt = target.optionsWithIndex?.find(o => /pickpocket/i.test(o.text));
    if (!pickpocketOpt) {
        ctx.warn('No pickpocket option');
        return false;
    }

    stats.pickpocketAttempts++;
    ctx.log(`Pickpocketing ${target.name} (dist: ${target.distance.toFixed(0)})...`);

    await ctx.sdk.sendInteractNpc(target.index, pickpocketOpt.opIndex);
    await new Promise(r => setTimeout(r, 1500));  // Wait for action
    markProgress(ctx);

    // Check result
    const gpAfter = getGP(ctx);
    const gained = gpAfter - gpBefore;

    if (gained > 0) {
        stats.successfulPickpockets++;
        stats.gpEarned += gained;
        ctx.log(`Pickpocket success! +${gained} GP (total: ${gpAfter} GP)`);
        return true;
    }

    // Check if stunned
    const messages = ctx.state()?.gameMessages ?? [];
    const recentMsg = messages.slice(-3).map(m => m.text).join(' ');
    if (/stun|caught/i.test(recentMsg)) {
        stats.stunned++;
        ctx.log('Stunned! Waiting 5s...');
        await new Promise(r => setTimeout(r, 5000));  // Stun lasts ~5 seconds
    }

    return false;
}

// === MAIN THIEVING LOOP ===
async function thievingLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    let noTargetCount = 0;
    let loopCount = 0;
    const BANK_THRESHOLD = 500;  // Bank when we have 500+ GP (more time thieving, less walking)

    while (true) {
        loopCount++;
        const currentState = ctx.state();
        if (!currentState) break;

        // Periodic status logging
        if (loopCount % 20 === 0) {
            const thievingLvl = getSkillLevel(ctx, 'Thieving');
            const currentGP = getGP(ctx);
            const hp = getHP(ctx);
            ctx.log(`Loop ${loopCount}: Thieving ${thievingLvl} | GP: ${currentGP} | HP: ${hp.current}/${hp.max} | Success: ${stats.successfulPickpockets} | Banked: ${stats.gpBanked}`);
        }

        // Dismiss dialogs
        if (currentState.dialog.isOpen) {
            ctx.log('Dismissing dialog...');
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Eat food if needed
        await eatFoodIfNeeded(ctx);

        // Check if we should bank
        const currentGP = getGP(ctx);
        if (currentGP >= BANK_THRESHOLD) {
            ctx.log(`Have ${currentGP} GP - time to bank!`);
            await bankCoins(ctx, stats);
            continue;
        }

        // Check for "You have been stunned!" message
        const recentMessages = currentState.gameMessages.slice(-5);
        const wasStunned = recentMessages.some(m => /stunned|failed|catch/i.test(m.text));
        const player = currentState.player;
        const isIdle = player?.animId === -1;

        if (wasStunned && !isIdle) {
            // Wait for stun to wear off
            await new Promise(r => setTimeout(r, 1500));
            markProgress(ctx);
            continue;
        }

        if (isIdle) {
            // Find a man to pickpocket
            const target = findMan(ctx);
            if (!target) {
                noTargetCount++;
                if (noTargetCount % 10 === 0) {
                    // Log nearby NPCs for debugging
                    const nearbyNpcs = currentState.nearbyNpcs.slice(0, 5);
                    ctx.log('Nearby NPCs: ' + nearbyNpcs.map(n => n.name + ' (opts: ' + n.options?.join(',') + ')').join(' | '));

                    ctx.log('No targets found (' + noTargetCount + ' attempts), walking to Lumbridge castle...');
                    await walkWaypoints(ctx, WAYPOINTS_TO_LUMBRIDGE);
                }
                await new Promise(r => setTimeout(r, 200));
                markProgress(ctx);
                continue;
            }

            noTargetCount = 0;
            await pickpocket(ctx, target, stats);
        }

        await new Promise(r => setTimeout(r, 300));
        markProgress(ctx);
    }
}

// === FINAL STATS ===
function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const duration = (Date.now() - stats.startTime) / 1000;
    const currentGP = getGP(ctx);

    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log('Duration: ' + Math.round(duration) + 's');
    ctx.log('Thieving Level: ' + getSkillLevel(ctx, 'Thieving'));
    ctx.log('Pickpocket Attempts: ' + stats.pickpocketAttempts);
    ctx.log('Successful: ' + stats.successfulPickpockets);
    ctx.log('Times Stunned: ' + stats.stunned);
    ctx.log('GP Earned: ' + stats.gpEarned);
    ctx.log('GP Banked: ' + stats.gpBanked);
    ctx.log('Total GP: ' + currentGP + ' (started with ' + stats.startGP + ')');
    ctx.log('Total Level: ' + getTotalLevel(ctx));
}

// === WAIT FOR STATE ===
async function waitForState(ctx: ScriptContext): Promise<boolean> {
    ctx.log('Waiting for game state...');
    try {
        await ctx.sdk.waitForCondition(s => {
            return !!(s.player && s.player.worldX > 0 && s.skills.some(skill => skill.baseLevel > 0));
        }, 45000);
        const state = ctx.state();
        ctx.log('State ready! Position: (' + state?.player?.worldX + ', ' + state?.player?.worldZ + ')');
        await new Promise(r => setTimeout(r, 1000));
        markProgress(ctx);
        return true;
    } catch (e) {
        ctx.warn('State did not populate after 45 seconds');
        return false;
    }
}

// === RUN THE ARC ===
runArc({
    characterName: 'brad_1',
    arcName: 'thieving-money',
    goal: 'Make money by pickpocketing men, bank at 200+ GP',
    timeLimit: 10 * 60 * 1000,
    stallTimeout: 90_000,  // 90 seconds (walking takes time)
    screenshotInterval: 30_000,
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        pickpocketAttempts: 0,
        successfulPickpockets: 0,
        gpEarned: 0,
        gpBanked: 0,
        bankTrips: 0,
        stunned: 0,
        startGP: 0,
        startTime: Date.now(),
    };

    ctx.log('=== Arc: thieving-money ===');
    ctx.log('Goal: Make money by pickpocketing men');

    const stateReady = await waitForState(ctx);

    if (!stateReady || ctx.state()?.player?.worldX === 0) {
        ctx.error('Cannot proceed without valid game state');
        return;
    }

    stats.startGP = getGP(ctx);
    const thievingLvl = getSkillLevel(ctx, 'Thieving');
    ctx.log('Starting: Thieving ' + thievingLvl + ', GP: ' + stats.startGP);
    ctx.log('Position: (' + ctx.state()?.player?.worldX + ', ' + ctx.state()?.player?.worldZ + ')');
    ctx.log('Total Level: ' + getTotalLevel(ctx));

    // Dismiss startup dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx);

    // Check if inside cow field (z > 3267) and exit first
    const player = ctx.state()?.player;
    if (player && player.worldZ > 3267) {
        ctx.log('Inside cow field (z=' + player.worldZ + '), exiting first...');

        // Walk to gate area
        ctx.log('Walking to gate area...');
        await ctx.sdk.sendWalk(3253, 3270, true);
        await new Promise(r => setTimeout(r, 2000));
        markProgress(ctx);

        // Open the gate
        ctx.log('Opening gate...');
        await ctx.bot.openDoor(/gate/i);
        await new Promise(r => setTimeout(r, 1500));
        markProgress(ctx);

        // Walk through gate (step by step)
        ctx.log('Walking through gate...');
        await ctx.sdk.sendWalk(3253, 3263, true);
        await new Promise(r => setTimeout(r, 2000));
        markProgress(ctx);

        await ctx.sdk.sendWalk(3250, 3255, true);
        await new Promise(r => setTimeout(r, 2000));
        markProgress(ctx);

        const afterGate = ctx.state()?.player;
        ctx.log('After exiting cow field: (' + afterGate?.worldX + ', ' + afterGate?.worldZ + ')');
    }

    // Walk to Lumbridge castle where men are
    const playerNow = ctx.state()?.player;
    if (playerNow && playerNow.worldX !== 0) {
        const distToLumbridge = Math.sqrt(
            Math.pow(playerNow.worldX - LOCATIONS.LUMBRIDGE_CASTLE.x, 2) +
            Math.pow(playerNow.worldZ - LOCATIONS.LUMBRIDGE_CASTLE.z, 2)
        );

        if (distToLumbridge > 30) {
            ctx.log('Walking to Lumbridge castle (dist: ' + distToLumbridge.toFixed(0) + ')...');
            await walkWaypoints(ctx, WAYPOINTS_TO_LUMBRIDGE);
        }
    }

    try {
        await thievingLoop(ctx, stats);
    } catch (e) {
        if (e instanceof StallError) {
            ctx.error('Arc aborted: ' + e.message);
        } else {
            throw e;
        }
    } finally {
        logFinalStats(ctx, stats);
    }
});
