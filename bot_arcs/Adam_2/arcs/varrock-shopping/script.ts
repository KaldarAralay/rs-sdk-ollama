/**
 * Varrock Shopping Arc - Adam_2
 *
 * Goal: Withdraw GP from Draynor bank and buy gear in Varrock
 *
 * Steps:
 * 1. Walk to Draynor Bank (from current position)
 * 2. Withdraw all GP
 * 3. Walk to Varrock Sword Shop (3203, 3398) and buy best affordable sword
 * 4. Walk to Horvik's Armour Shop (3195, 3427) and buy armor
 * 5. Equip new gear
 */

import { ScriptContext, runArc } from '../../../arc-runner';

// === LOCATIONS ===
const LOCATIONS = {
    DRAYNOR_BANK: { x: 3092, z: 3243 },
    LUMBRIDGE_CENTER: { x: 3222, z: 3218 },
    VARROCK_SWORD_SHOP: { x: 3203, z: 3398 },
    VARROCK_ARMOUR_SHOP: { x: 3195, z: 3427 },
};

// Waypoints from Lumbridge to Draynor Bank
const WAYPOINTS_LUM_TO_DRAYNOR = [
    { x: 3200, z: 3230 },
    { x: 3170, z: 3240 },
    { x: 3140, z: 3245 },
    { x: 3110, z: 3243 },
    { x: 3092, z: 3243 },
];

// Waypoints from Draynor to Varrock Sword Shop (going north then east)
const WAYPOINTS_DRAYNOR_TO_SWORD_SHOP = [
    { x: 3100, z: 3260 },   // North from Draynor
    { x: 3120, z: 3290 },   // Northeast
    { x: 3140, z: 3320 },   // Continue
    { x: 3160, z: 3350 },   // Avoid dark wizards (west route)
    { x: 3180, z: 3380 },   // Approach Varrock from west
    { x: 3203, z: 3398 },   // Sword shop
];

// Waypoints from Sword Shop to Armour Shop (short walk north)
const WAYPOINTS_SWORD_TO_ARMOUR = [
    { x: 3200, z: 3410 },   // North
    { x: 3195, z: 3427 },   // Horvik's
];

// === STATS ===
interface Stats {
    gpWithdrawn: number;
    gpSpent: number;
    itemsBought: string[];
    equipSuccess: boolean;
}

// === HELPERS ===
function getCoins(ctx: ScriptContext): number {
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

function markProgress(ctx: ScriptContext): void {
    ctx.sdk.getState();
}

async function walkWaypoints(ctx: ScriptContext, waypoints: Array<{x: number, z: number}>, desc: string): Promise<boolean> {
    ctx.log(`Walking ${desc}...`);
    for (let i = 0; i < waypoints.length; i++) {
        const wp = waypoints[i];
        ctx.log(`  Waypoint ${i + 1}/${waypoints.length}: (${wp.x}, ${wp.z})`);

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await ctx.bot.walkTo(wp.x, wp.z);
                markProgress(ctx);
                break;
            } catch (e) {
                ctx.warn(`Walk attempt ${attempt + 1} failed, retrying...`);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // Dismiss any dialogs
        if (ctx.state()?.dialog?.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 300));
        }
    }
    return true;
}

// === BANKING - WITHDRAW GP ===
async function withdrawGP(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Withdrawing GP from Draynor Bank ===');

    // Open bank
    const banker = ctx.state()?.nearbyNpcs.find(n => /banker/i.test(n.name));
    if (!banker) {
        ctx.warn('No banker found!');
        return false;
    }

    const bankOpt = banker.optionsWithIndex?.find(o => /bank/i.test(o.text));
    if (!bankOpt) {
        ctx.warn('No bank option');
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

    // Get current GP in inventory before withdrawal
    const gpBefore = getCoins(ctx);

    // Withdraw all GP (slot 0, -1 for all)
    // Bank slot 0 should have coins from previous deposits
    ctx.log('Withdrawing all GP from bank slot 0...');
    await ctx.sdk.sendBankWithdraw(0, -1);  // Withdraw all

    // Wait for coins to appear in inventory
    try {
        await ctx.sdk.waitForCondition(
            s => {
                const coins = s.inventory.find(i => /coins/i.test(i.name));
                return (coins?.count ?? 0) > gpBefore;
            },
            5000
        );
        ctx.log('GP withdrawn successfully!');
    } catch (e) {
        ctx.warn('Withdraw verification timed out');
    }

    await ctx.bot.closeShop();
    await new Promise(r => setTimeout(r, 500));

    const gpAfter = getCoins(ctx);
    stats.gpWithdrawn = gpAfter - gpBefore;

    ctx.log(`Withdrew ${stats.gpWithdrawn} GP (total: ${gpAfter} GP)`);

    return gpAfter > 0;
}

// === SHOPPING ===
async function buyFromShop(ctx: ScriptContext, stats: Stats, shopType: 'sword' | 'armour'): Promise<boolean> {
    ctx.log(`=== Shopping at ${shopType === 'sword' ? 'Varrock Sword Shop' : "Horvik's Armour"} ===`);

    // Find shop NPC
    const shopNpc = ctx.state()?.nearbyNpcs.find(n =>
        shopType === 'sword'
            ? /shop.?keeper|sword/i.test(n.name)
            : /horvik|armour/i.test(n.name)
    );

    if (!shopNpc) {
        ctx.warn(`No ${shopType} shop NPC found nearby`);
        return false;
    }

    ctx.log(`Found NPC: ${shopNpc.name}`);

    // Find trade option
    const tradeOpt = shopNpc.optionsWithIndex?.find(o => /trade/i.test(o.text));
    if (!tradeOpt) {
        ctx.warn('No trade option');
        return false;
    }

    await ctx.sdk.sendInteractNpc(shopNpc.index, tradeOpt.opIndex);

    // Wait for shop to open
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 400));
        if (ctx.state()?.shop?.isOpen) {
            ctx.log('Shop opened!');
            break;
        }
        markProgress(ctx);
    }

    const shopState = ctx.state()?.shop;
    if (!shopState?.isOpen) {
        ctx.warn('Shop did not open');
        return false;
    }

    ctx.log(`Shop: ${shopState.title || 'Unknown'}`);
    ctx.log(`Items available: ${shopState.items?.length ?? 0}`);

    // List shop items
    const items = shopState.items ?? [];
    for (const item of items.slice(0, 10)) {
        ctx.log(`  ${item.name}: ${item.price} GP (stock: ${item.count})`);
    }

    // Buy strategy: buy the best item we can afford
    const gp = getCoins(ctx);
    ctx.log(`Available GP: ${gp}`);

    // For swords: prefer longswords, then swords, then daggers
    // For armour: prefer platebody, then chainbody, then helmet
    let targetItems: string[];
    if (shopType === 'sword') {
        // Prioritize from best to worst that we can afford
        targetItems = [
            'rune longsword', 'adamant longsword', 'mithril longsword', 'steel longsword', 'iron longsword', 'bronze longsword',
            'rune sword', 'adamant sword', 'mithril sword', 'steel sword', 'iron sword', 'bronze sword',
        ];
    } else {
        targetItems = [
            'rune platebody', 'adamant platebody', 'mithril platebody', 'steel platebody', 'iron platebody', 'bronze platebody',
            'rune chainbody', 'adamant chainbody', 'mithril chainbody', 'steel chainbody', 'iron chainbody', 'bronze chainbody',
        ];
    }

    // Find best affordable item
    for (const targetName of targetItems) {
        const item = items.find(i => i.name.toLowerCase().includes(targetName.toLowerCase()));
        if (item && item.price <= gp && item.count > 0) {
            ctx.log(`Buying: ${item.name} for ${item.price} GP`);

            // Buy item (slot, count)
            const itemSlot = items.indexOf(item);
            await ctx.sdk.sendShopBuy(itemSlot, 1);

            await new Promise(r => setTimeout(r, 500));
            markProgress(ctx);

            stats.gpSpent += item.price;
            stats.itemsBought.push(item.name);

            ctx.log(`Bought ${item.name}!`);
            break;
        }
    }

    // Close shop
    await ctx.bot.closeShop();
    await new Promise(r => setTimeout(r, 300));

    return true;
}

// === EQUIP GEAR ===
async function equipGear(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Equipping New Gear ===');

    const inventory = ctx.state()?.inventory ?? [];

    // Find equippable items (swords, armour)
    const equipRegex = /sword|longsword|platebody|chainbody|helmet|legs|shield/i;
    const toEquip = inventory.filter(i => equipRegex.test(i.name));

    ctx.log(`Found ${toEquip.length} items to equip`);

    for (const item of toEquip) {
        ctx.log(`Equipping: ${item.name}`);

        // Find wield/wear option
        const wieldOpt = item.optionsWithIndex?.find(o => /wield|wear|equip/i.test(o.text));
        if (wieldOpt) {
            await ctx.sdk.sendClickInventory(item.slot, wieldOpt.opIndex);
            await new Promise(r => setTimeout(r, 300));
            markProgress(ctx);
            ctx.log(`  Equipped ${item.name}!`);
        } else {
            ctx.warn(`  No equip option for ${item.name}`);
        }
    }

    stats.equipSuccess = true;
    return true;
}

// === MAIN ARC ===
async function run(ctx: ScriptContext): Promise<void> {
    const stats: Stats = {
        gpWithdrawn: 0,
        gpSpent: 0,
        itemsBought: [],
        equipSuccess: false,
    };

    // Step 1: Walk to Draynor Bank
    ctx.log('=== PHASE 1: Withdraw GP from Draynor Bank ===');
    await walkWaypoints(ctx, WAYPOINTS_LUM_TO_DRAYNOR, 'to Draynor Bank');

    // Step 2: Withdraw GP
    const withdrawSuccess = await withdrawGP(ctx, stats);
    if (!withdrawSuccess) {
        ctx.warn('Failed to withdraw GP');
        return;
    }

    const gp = getCoins(ctx);
    if (gp < 100) {
        ctx.warn(`Not enough GP to shop (${gp})`);
        return;
    }

    // Step 3: Walk to Varrock Sword Shop
    ctx.log('=== PHASE 2: Buy Sword in Varrock ===');
    await walkWaypoints(ctx, WAYPOINTS_DRAYNOR_TO_SWORD_SHOP, 'to Varrock Sword Shop');

    // Step 4: Buy sword
    await buyFromShop(ctx, stats, 'sword');

    // Step 5: Walk to Armour Shop
    ctx.log('=== PHASE 3: Buy Armour at Horvik\'s ===');
    await walkWaypoints(ctx, WAYPOINTS_SWORD_TO_ARMOUR, 'to Horvik\'s Armour');

    // Step 6: Buy armour
    await buyFromShop(ctx, stats, 'armour');

    // Step 7: Equip gear
    ctx.log('=== PHASE 4: Equip New Gear ===');
    await equipGear(ctx, stats);

    // Summary
    ctx.log('=== SHOPPING COMPLETE ===');
    ctx.log(`GP Withdrawn: ${stats.gpWithdrawn}`);
    ctx.log(`GP Spent: ${stats.gpSpent}`);
    ctx.log(`Items Bought: ${stats.itemsBought.join(', ') || 'none'}`);
    ctx.log(`Equip Success: ${stats.equipSuccess}`);
}

// Run the arc
runArc({
    characterName: 'Adam_2',
    arcName: 'varrock-shopping',
    goal: 'Withdraw GP and buy gear in Varrock',
    timeLimit: 10 * 60 * 1000,  // 10 minutes
    stallTimeout: 90_000,
    launchOptions: {
        useSharedBrowser: false,
    },
}, run);
