/**
 * Arc: skill-money
 * Character: Adam_2
 *
 * Goal: Make money by killing cows, selling hides at general store.
 * Strategy:
 * 1. Kill cows at Lumbridge cow field, collect hides
 * 2. When inventory has 15+ hides, walk to Lumbridge General Store and sell
 * 3. When GP >= 200, bank it at Lumbridge bank
 * 4. Repeat
 *
 * Duration: 15 minutes
 */

import { runArc, StallError } from '../../../arc-runner.ts';
import type { ScriptContext } from '../../../arc-runner.ts';
import type { NearbyNpc } from '../../../../agent/types.ts';

// === LOCATIONS ===
const LOCATIONS = {
    COW_FIELD: { x: 3253, z: 3270 },
    LUMBRIDGE_GEN_STORE: { x: 3212, z: 3247 },
    LUMBRIDGE_BANK: { x: 3208, z: 3220 },  // Lumbridge top floor bank - but we'll use Draynor
    DRAYNOR_BANK: { x: 3092, z: 3243 },
};

// Waypoints from cow field to Lumbridge General Store (staying north of Dark Wizards)
const WAYPOINTS_TO_STORE = [
    { x: 3240, z: 3270 },  // Exit cow field west
    { x: 3220, z: 3260 },  // Continue west
    { x: 3212, z: 3247 },  // General store
];

const WAYPOINTS_TO_COWS = [
    { x: 3220, z: 3260 },  // East from store
    { x: 3240, z: 3270 },  // Towards cow field
    { x: 3253, z: 3270 },  // Cow field
];

// From Lumbridge to Draynor Bank (avoid Dark Wizards at ~3220, 3220)
const WAYPOINTS_TO_BANK = [
    { x: 3200, z: 3260 },  // West from store, staying north
    { x: 3170, z: 3250 },  // Continue west
    { x: 3140, z: 3245 },  // Towards Draynor
    { x: 3110, z: 3243 },  // Near Draynor
    { x: 3092, z: 3243 },  // Draynor Bank
];

const WAYPOINTS_FROM_BANK = [
    { x: 3110, z: 3243 },  // East from Draynor
    { x: 3140, z: 3245 },  // Continue east
    { x: 3170, z: 3250 },  // Past swamp
    { x: 3200, z: 3260 },  // North of Dark Wizards
    { x: 3220, z: 3260 },  // Near store
    { x: 3253, z: 3270 },  // Cow field
];

// === COMBAT STYLES ===
const COMBAT_STYLES = {
    ACCURATE: 0,    // Trains Attack
    AGGRESSIVE: 1,  // Trains Strength
    DEFENSIVE: 3,   // Trains Defence
};

const STYLE_ROTATION = [
    { style: COMBAT_STYLES.ACCURATE, name: 'Accurate (Attack)' },
    { style: COMBAT_STYLES.AGGRESSIVE, name: 'Aggressive (Strength)' },
    { style: COMBAT_STYLES.DEFENSIVE, name: 'Defensive (Defence)' },
];

let lastStyleChange = 0;
let currentStyleIndex = 0;
let lastSetStyle = -1;
const STYLE_CYCLE_MS = 30_000;

// === STATS ===
interface Stats {
    kills: number;
    hidesLooted: number;
    hidesSold: number;
    gpEarned: number;
    gpBanked: number;
    sellTrips: number;
    bankTrips: number;
    startTime: number;
}

function markProgress(ctx: ScriptContext): void {
    ctx.progress();
}

function getSkillLevel(ctx: ScriptContext, name: string): number {
    return ctx.state()?.skills.find(s => s.name === name)?.baseLevel ?? 1;
}

function getHP(ctx: ScriptContext): { current: number; max: number } {
    const hp = ctx.state()?.skills.find(s => s.name === 'Hitpoints');
    return { current: hp?.level ?? 10, max: hp?.baseLevel ?? 10 };
}

function countHides(ctx: ScriptContext): number {
    const inv = ctx.state()?.inventory ?? [];
    return inv.filter(i => /cow\s*hide/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
}

function getCoins(ctx: ScriptContext): number {
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

function getInventorySpace(ctx: ScriptContext): number {
    return 28 - (ctx.state()?.inventory?.length ?? 0);
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 0;
}

// === WALKING ===
async function walkWaypoints(ctx: ScriptContext, waypoints: {x: number, z: number}[]): Promise<boolean> {
    for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
        const wp = waypoints[wpIdx]!;
        const player = ctx.state()?.player;
        const startDist = player ? Math.sqrt(
            Math.pow(player.worldX - wp.x, 2) +
            Math.pow(player.worldZ - wp.z, 2)
        ) : 999;

        ctx.log(`Walking to waypoint ${wpIdx + 1}/${waypoints.length}: (${wp.x}, ${wp.z}) - ${Math.round(startDist)} tiles away`);

        // Dismiss dialogs first
        if (ctx.state()?.dialog?.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 300));
        }

        const result = await ctx.bot.walkTo(wp.x, wp.z);
        markProgress(ctx);

        if (!result.success) {
            ctx.warn(`Walk failed: ${result.message}`);
            await ctx.bot.openDoor(/gate|door/i);
            await new Promise(r => setTimeout(r, 500));
            const retry = await ctx.bot.walkTo(wp.x, wp.z);
            if (!retry.success) {
                ctx.warn(`Walk retry failed: ${retry.message}`);
            }
        }

        const afterPlayer = ctx.state()?.player;
        if (afterPlayer) {
            ctx.log(`Now at: (${afterPlayer.worldX}, ${afterPlayer.worldZ})`);
        }
    }
    return true;
}

// === SELLING ===
// NOTE: General store gives 0 GP for hides - so we skip selling and just drop hides when full
async function dropExcessHides(ctx: ScriptContext): Promise<number> {
    ctx.log('=== Dropping excess hides to make room ===');

    const inv = ctx.state()?.inventory ?? [];
    const hides = inv.filter(i => /cow\s*hide/i.test(i.name));

    if (hides.length <= 5) {
        ctx.log('Not enough hides to drop');
        return 0;
    }

    // Drop all but 5 hides
    let dropped = 0;
    for (let i = 0; i < hides.length - 5; i++) {
        const hide = hides[i];
        if (hide) {
            await ctx.sdk.sendDropItem(hide.slot);
            dropped++;
            await new Promise(r => setTimeout(r, 200));
        }
    }

    ctx.log(`Dropped ${dropped} hides to make inventory room`);
    return dropped;
}

async function sellHides(ctx: ScriptContext, stats: Stats): Promise<number> {
    // General store gives 0 GP, so just drop hides instead
    ctx.log('General store gives 0 GP for hides - dropping instead');
    await dropExcessHides(ctx);
    stats.hidesSold += countHides(ctx);
    return 0;
}

// === BANKING ===
async function bankCoins(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Banking GP at Draynor Bank ===');
    stats.bankTrips++;

    const gpBefore = getCoins(ctx);
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

    // Deposit coins
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    if (coins) {
        await ctx.sdk.sendBankDeposit(coins.slot, coins.count ?? 1);
        await new Promise(r => setTimeout(r, 500));
        markProgress(ctx);
    }

    await ctx.bot.closeShop();

    const gpAfter = getCoins(ctx);
    const banked = gpBefore - gpAfter;
    stats.gpBanked += banked;

    ctx.log(`Banked ${banked} GP (total banked: ${stats.gpBanked})`);

    // Return to cow field
    ctx.log('Returning to cow field...');
    await walkWaypoints(ctx, WAYPOINTS_FROM_BANK);

    return true;
}

// === COMBAT ===
function findCow(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    const cows = state.nearbyNpcs
        .filter(npc => /^cow$/i.test(npc.name))
        .filter(npc => npc.options.some(opt => /attack/i.test(opt)))
        .filter(npc => !npc.inCombat)
        .sort((a, b) => a.distance - b.distance);

    return cows[0] ?? null;
}

async function cycleCombatStyle(ctx: ScriptContext): Promise<void> {
    const now = Date.now();
    if (now - lastStyleChange >= STYLE_CYCLE_MS) {
        currentStyleIndex = (currentStyleIndex + 1) % STYLE_ROTATION.length;
        lastStyleChange = now;
    }

    const target = STYLE_ROTATION[currentStyleIndex]!;
    if (lastSetStyle !== target.style) {
        ctx.log('Combat style: ' + target.name);
        await ctx.sdk.sendSetCombatStyle(target.style);
        lastSetStyle = target.style;
    }
}

async function lootHide(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    const space = getInventorySpace(ctx);
    if (space <= 0) return false;

    const groundItems = ctx.sdk.getGroundItems();
    const hide = groundItems
        .filter(i => /cow\s*hide/i.test(i.name))
        .filter(i => i.distance <= 5)
        .sort((a, b) => a.distance - b.distance)[0];

    if (hide) {
        const result = await ctx.bot.pickupItem(hide);
        if (result.success) {
            stats.hidesLooted++;
            ctx.log(`Looted cowhide (${countHides(ctx)} in inv)`);
            markProgress(ctx);
            return true;
        }
    }
    return false;
}

// === MAIN LOOP ===
async function mainLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    lastStyleChange = Date.now();
    currentStyleIndex = 0;
    lastSetStyle = -1;
    let noCowCount = 0;
    let loopCount = 0;

    const SELL_THRESHOLD = 20;  // Sell when we have this many hides (increased to reduce travel time)
    const BANK_THRESHOLD = 200; // Bank when we have this much GP

    while (true) {
        loopCount++;
        const currentState = ctx.state();
        if (!currentState) break;

        // Periodic status
        if (loopCount % 40 === 0) {
            const atk = getSkillLevel(ctx, 'Attack');
            const str = getSkillLevel(ctx, 'Strength');
            const def = getSkillLevel(ctx, 'Defence');
            const hp = getHP(ctx);
            const hides = countHides(ctx);
            const gp = getCoins(ctx);
            ctx.log(`Loop ${loopCount}: Atk ${atk}, Str ${str}, Def ${def} | HP: ${hp.current}/${hp.max} | Kills: ${stats.kills} | Hides: ${hides} | GP: ${gp}`);
        }

        // Dismiss dialogs
        if (currentState.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Check if we should bank GP
        const gp = getCoins(ctx);
        if (gp >= BANK_THRESHOLD) {
            ctx.log(`Have ${gp} GP - banking!`);
            await bankCoins(ctx, stats);
            // Open gate to re-enter cow field
            await ctx.bot.openDoor(/gate/i);
            await new Promise(r => setTimeout(r, 500));
            continue;
        }

        // Check if we should sell hides
        const hides = countHides(ctx);
        if (hides >= SELL_THRESHOLD || getInventorySpace(ctx) <= 0) {
            ctx.log(`Inventory has ${hides} hides - time to sell!`);
            await sellHides(ctx, stats);
            // Walk back to cows
            ctx.log('Returning to cow field...');
            await walkWaypoints(ctx, WAYPOINTS_TO_COWS);
            await ctx.bot.openDoor(/gate/i);
            await new Promise(r => setTimeout(r, 500));
            continue;
        }

        // Cycle combat style
        await cycleCombatStyle(ctx);

        // Try to loot nearby hides first
        const space = getInventorySpace(ctx);
        if (space > 0) {
            await lootHide(ctx, stats);
        }

        // Check if idle
        const player = currentState.player;
        const isIdle = player?.animId === -1;

        if (isIdle) {
            const cow = findCow(ctx);
            if (!cow) {
                noCowCount++;
                if (noCowCount % 20 === 0) {
                    ctx.log('No cows found, walking to field center...');
                    await ctx.sdk.sendWalk(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z, true);
                    await new Promise(r => setTimeout(r, 2000));
                    markProgress(ctx);
                }
                await new Promise(r => setTimeout(r, 200));
                markProgress(ctx);
                continue;
            }

            noCowCount = 0;

            const attackResult = await ctx.bot.attackNpc(cow);
            if (attackResult.success) {
                stats.kills++;
                markProgress(ctx);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                if (attackResult.reason === 'out_of_reach') {
                    await ctx.bot.openDoor(/gate/i);
                    markProgress(ctx);
                }
            }
        }

        await new Promise(r => setTimeout(r, 600));
        markProgress(ctx);
    }
}

// === RUN THE ARC ===
runArc({
    characterName: 'Adam_2',
    arcName: 'skill-money',
    goal: 'Kill cows, sell hides for GP, bank when 200+ GP',
    timeLimit: 15 * 60 * 1000,  // 15 minutes
    stallTimeout: 90_000,
    screenshotInterval: 30_000,
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        kills: 0,
        hidesLooted: 0,
        hidesSold: 0,
        gpEarned: 0,
        gpBanked: 0,
        sellTrips: 0,
        bankTrips: 0,
        startTime: Date.now(),
    };

    ctx.log('=== Arc: skill-money ===');
    ctx.log('Goal: Kill cows -> Sell hides -> Bank GP when 200+');

    // Wait for state
    ctx.log('Waiting for state...');
    try {
        await ctx.sdk.waitForCondition(s => {
            return !!(s.player && s.player.worldX > 0 && s.skills.some(skill => skill.baseLevel > 0));
        }, 30000);
    } catch (e) {
        ctx.error('State did not populate');
        return;
    }
    await new Promise(r => setTimeout(r, 500));

    const state = ctx.state();
    if (!state?.player || state.player.worldX === 0) {
        ctx.error('Invalid state');
        return;
    }

    ctx.log('Position: (' + state.player.worldX + ', ' + state.player.worldZ + ')');
    ctx.log('Stats: Attack ' + getSkillLevel(ctx, 'Attack') + ', Strength ' + getSkillLevel(ctx, 'Strength') + ', Defence ' + getSkillLevel(ctx, 'Defence'));
    ctx.log('Total Level: ' + getTotalLevel(ctx));
    ctx.log('Hides in inventory: ' + countHides(ctx));
    ctx.log('GP: ' + getCoins(ctx));

    // First check if we already have hides to sell
    const startHides = countHides(ctx);
    if (startHides > 0) {
        ctx.log(`Found ${startHides} hides in inventory - selling first!`);
        await sellHides(ctx, stats);
    }

    // Equip gear
    const inv = state.inventory;
    const equip = state.equipment;

    const hasWeapon = equip.some(e => e && /sword|axe|mace|dagger|scimitar/i.test(e.name));
    if (!hasWeapon) {
        const weapon = inv.find(i => /sword|mace|scimitar/i.test(i.name) && !/pickaxe/i.test(i.name));
        if (weapon) {
            ctx.log('Equipping ' + weapon.name);
            await ctx.bot.equipItem(weapon);
            markProgress(ctx);
        }
    }

    const shield = inv.find(i => /shield/i.test(i.name));
    if (shield) {
        ctx.log('Equipping ' + shield.name);
        await ctx.bot.equipItem(shield);
        markProgress(ctx);
    }

    // Dismiss dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx);

    // Walk to cow field
    const player = ctx.state()?.player;
    const distToCows = player ? Math.sqrt(
        Math.pow(player.worldX - LOCATIONS.COW_FIELD.x, 2) +
        Math.pow(player.worldZ - LOCATIONS.COW_FIELD.z, 2)
    ) : 999;

    if (distToCows > 30) {
        ctx.log(`Not near cow field (${Math.round(distToCows)} tiles away), walking there...`);
        await walkWaypoints(ctx, WAYPOINTS_TO_COWS);
    }

    // Open gate to enter
    await ctx.bot.openDoor(/gate/i);
    await new Promise(r => setTimeout(r, 500));
    markProgress(ctx);

    // Main loop
    try {
        await mainLoop(ctx, stats);
    } catch (e) {
        if (e instanceof StallError) {
            ctx.error('Arc stalled: ' + e.message);
        } else {
            throw e;
        }
    }

    // Final stats
    const duration = (Date.now() - stats.startTime) / 1000;
    ctx.log('');
    ctx.log('=== Final Stats ===');
    ctx.log('Duration: ' + Math.round(duration) + 's');
    ctx.log('Kills: ' + stats.kills);
    ctx.log('Hides looted: ' + stats.hidesLooted);
    ctx.log('Hides sold: ' + stats.hidesSold);
    ctx.log('GP earned: ' + stats.gpEarned);
    ctx.log('GP banked: ' + stats.gpBanked);
    ctx.log('Sell trips: ' + stats.sellTrips);
    ctx.log('Bank trips: ' + stats.bankTrips);
    ctx.log('Attack: ' + getSkillLevel(ctx, 'Attack'));
    ctx.log('Strength: ' + getSkillLevel(ctx, 'Strength'));
    ctx.log('Defence: ' + getSkillLevel(ctx, 'Defence'));
    ctx.log('Total Level: ' + getTotalLevel(ctx));
    ctx.log('Final GP: ' + getCoins(ctx));
});
