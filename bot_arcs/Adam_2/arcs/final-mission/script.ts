/**
 * Arc: final-mission
 * Character: Adam_2
 *
 * FINAL MISSION: Cash out ~152 cowhides and gear up!
 *
 * Steps:
 * 1. Go to Varrock West Bank (3185, 3436)
 * 2. Withdraw ALL cowhides as NOTES
 * 3. Walk to Lumbridge General Store (3212, 3246)
 * 4. Sell ALL noted cowhides
 * 5. Walk to Varrock Sword Shop (3204, 3497)
 * 6. Buy BEST sword affordable (60% budget)
 * 7. Walk to Varrock Armor Shop (nearby)
 * 8. Buy armor with remaining gold (40% budget)
 * 9. EQUIP all new gear
 * 10. Take victory screenshot and save to victory.png
 *
 * ONE-TIME mission - does NOT loop!
 */

import { runArc, StallError } from '../../../arc-runner.ts';
import type { ScriptContext } from '../../../arc-runner.ts';
import { writeFileSync } from 'fs';

// Locations
const LOCATIONS = {
    DRAYNOR_BANK: { x: 3092, z: 3243 },        // Where character is, where hides are banked
    VARROCK_WEST_BANK: { x: 3185, z: 3436 },
    LUMBRIDGE_GEN_STORE: { x: 3212, z: 3246 },
    DRAYNOR_GEN_STORE: { x: 3082, z: 3249 },   // Closer! Diango's toy stall area
    VARROCK_SWORD_SHOP: { x: 3204, z: 3399 },  // Zaff's Superior Staffs area
    VARROCK_ARMOR_SHOP: { x: 3209, z: 3420 },  // Horvik's Armour Shop
};

// Sword prices (approximate)
const SWORDS = [
    { pattern: /adamant long/i, price: 2880 },
    { pattern: /adamant sword/i, price: 1920 },
    { pattern: /mithril long/i, price: 1040 },
    { pattern: /mithril sword/i, price: 650 },
    { pattern: /steel long/i, price: 400 },
    { pattern: /steel sword/i, price: 260 },
    { pattern: /iron long/i, price: 140 },
    { pattern: /iron sword/i, price: 91 },
];

// Armor pieces (chainbody, platelegs, helm in priority order)
const ARMOR = [
    // Bodies (prioritize chainbody for no quest req)
    { pattern: /adamant chain/i, price: 1440, slot: 'body' },
    { pattern: /mithril chain/i, price: 520, slot: 'body' },
    { pattern: /steel chain/i, price: 200, slot: 'body' },
    { pattern: /iron chain/i, price: 70, slot: 'body' },
    // Legs
    { pattern: /adamant.*leg/i, price: 2560, slot: 'legs' },
    { pattern: /mithril.*leg/i, price: 920, slot: 'legs' },
    { pattern: /steel.*leg/i, price: 350, slot: 'legs' },
    { pattern: /iron.*leg/i, price: 140, slot: 'legs' },
    // Helms
    { pattern: /adamant.*helm/i, price: 1056, slot: 'helm' },
    { pattern: /mithril.*helm/i, price: 364, slot: 'helm' },
    { pattern: /steel.*helm/i, price: 140, slot: 'helm' },
    { pattern: /iron.*helm/i, price: 56, slot: 'helm' },
];

function getCoins(ctx: ScriptContext): number {
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 30;
}

async function waitForGameState(ctx: ScriptContext): Promise<boolean> {
    ctx.log('Waiting for game state to load...');
    for (let i = 0; i < 60; i++) {
        const state = ctx.state();
        if (state?.player?.worldX !== 0 && state?.player?.worldZ !== 0) {
            ctx.log(`State loaded after ${i * 500}ms`);
            return true;
        }
        if (i % 10 === 0) ctx.log(`Waiting... (${i * 500}ms)`);
        await new Promise(r => setTimeout(r, 500));
        ctx.progress();
    }
    ctx.error('State never loaded!');
    return false;
}

async function openBankAndWithdraw(ctx: ScriptContext): Promise<boolean> {
    ctx.log('=== Opening bank to withdraw hides ===');

    // Walk closer to bank if needed
    const bankBooth = ctx.sdk.findNearbyLoc(/bank booth/i);
    if (bankBooth && bankBooth.distance > 2) {
        ctx.log(`Walking closer to bank booth (distance: ${bankBooth.distance})`);
        await ctx.bot.walkTo(bankBooth.x, bankBooth.z);
        await new Promise(r => setTimeout(r, 1000));
        ctx.progress();
    }

    // Try to open bank with banker NPC (more reliable)
    const banker = ctx.sdk.findNearbyNpc(/banker/i);
    const bankBoothNow = ctx.sdk.findNearbyLoc(/bank booth/i);

    if (banker) {
        ctx.log(`Found banker at distance ${banker.distance}`);
        const bankOpt = banker.optionsWithIndex.find(o => /bank/i.test(o.text));
        if (bankOpt) {
            ctx.log(`Using banker 'Bank' option (opIndex: ${bankOpt.opIndex})`);
            await ctx.sdk.sendInteractNpc(banker.index, bankOpt.opIndex);
        } else {
            ctx.log(`Banker options: ${banker.options.join(', ')}`);
            // Try option 2 which is often "Bank" in OSRS
            await ctx.sdk.sendInteractNpc(banker.index, 2);
        }
    } else if (bankBoothNow) {
        ctx.log(`Found bank booth at distance ${bankBoothNow.distance}`);
        ctx.log(`Booth options: ${bankBoothNow.options.join(', ')}`);
        const useOpt = bankBoothNow.optionsWithIndex.find(o => /use|bank/i.test(o.text));
        if (useOpt) {
            await ctx.sdk.sendInteractLoc(bankBoothNow.x, bankBoothNow.z, bankBoothNow.id, useOpt.opIndex);
        } else {
            // Try option 2 which is often "Bank" for booths
            await ctx.sdk.sendInteractLoc(bankBoothNow.x, bankBoothNow.z, bankBoothNow.id, 2);
        }
    } else {
        ctx.error('No bank booth or banker found!');
        return false;
    }

    // Wait for bank interface to open
    ctx.log('Waiting for bank interface to open...');
    let bankOpened = false;
    for (let i = 0; i < 20; i++) {  // 10 seconds max
        await new Promise(r => setTimeout(r, 500));
        ctx.progress();

        const state = ctx.state();
        // Check various ways bank might be detected
        if (state?.modalOpen || state?.interface?.isOpen || (state?.modalInterface && state.modalInterface > 0)) {
            ctx.log(`Bank opened! modalOpen=${state.modalOpen}, interface.isOpen=${state.interface?.isOpen}, modalInterface=${state.modalInterface}`);
            bankOpened = true;
            break;
        }

        if (i % 4 === 0) {
            ctx.log(`Waiting for bank... (${i * 500}ms)`);
        }
    }

    if (!bankOpened) {
        ctx.warn('Bank interface did not open, trying anyway...');
    }

    // Wait a bit more for interface to fully load
    await new Promise(r => setTimeout(r, 1000));

    // Try withdrawing from ALL slots (hides might be in different slots)
    ctx.log('Attempting to withdraw all items from bank...');
    for (let slot = 0; slot < 20; slot++) {  // Check 20 slots
        const result = await ctx.sdk.sendBankWithdraw(slot, 9999);
        const inv = ctx.state()?.inventory ?? [];
        if (slot < 5 || inv.length > 0) {
            ctx.log(`Slot ${slot}: ${result.message} - Inventory: ${inv.length} items`);
        }
        await new Promise(r => setTimeout(r, 150));
        ctx.progress();

        // If inventory is getting full, stop
        if (inv.length >= 26) {
            ctx.log('Inventory nearly full, stopping withdrawal');
            break;
        }
    }

    // Wait and check what we got
    await new Promise(r => setTimeout(r, 500));

    const inv = ctx.state()?.inventory ?? [];
    ctx.log(`Inventory after bank: ${inv.length} items`);
    for (const item of inv) {
        ctx.log(`  - ${item.name} x${item.count}`);
    }

    const hides = inv.find(i => /cow\s*hide/i.test(i.name));
    if (hides) {
        ctx.log(`Got ${hides.count} cowhides!`);
        return true;
    }

    // Even if no hides, continue with whatever we have
    if (inv.length > 0) {
        ctx.log('Got some items, continuing...');
        return true;
    }

    ctx.warn('No items withdrawn from bank');
    return false;
}

async function sellAtGeneralStore(ctx: ScriptContext): Promise<number> {
    ctx.log('=== Selling at Lumbridge General Store ===');

    // Open shop
    const result = await ctx.bot.openShop(/shop\s*(keeper|assistant)/i);
    if (!result.success) {
        ctx.warn(`Failed to open shop: ${result.message}`);
        return 0;
    }

    ctx.log('Shop opened, selling hides...');
    await new Promise(r => setTimeout(r, 500));

    const coinsBefore = getCoins(ctx);

    // Find and sell all cowhides
    const hides = ctx.sdk.findInventoryItem(/cow\s*hide/i);
    if (hides) {
        ctx.log(`Selling ${hides.count} cowhides...`);
        const sellResult = await ctx.bot.sellToShop(hides, 'all');
        ctx.log(`Sell result: ${sellResult.message}`);
        await new Promise(r => setTimeout(r, 500));
    }

    // Also try selling any noted cowhides
    const notedHides = ctx.sdk.findInventoryItem(/cow\s*hide.*note/i);
    if (notedHides) {
        ctx.log(`Selling ${notedHides.count} noted cowhides...`);
        const sellResult = await ctx.bot.sellToShop(notedHides, 'all');
        ctx.log(`Sell result: ${sellResult.message}`);
    }

    const coinsAfter = getCoins(ctx);
    const earned = coinsAfter - coinsBefore;
    ctx.log(`Earned ${earned} GP from selling hides`);

    await ctx.bot.closeShop();
    return earned;
}

async function buyBestSword(ctx: ScriptContext, budget: number): Promise<string | null> {
    ctx.log(`=== Buying sword (budget: ${budget} GP) ===`);

    // Open shop
    const result = await ctx.bot.openShop(/shop/i);
    if (!result.success) {
        ctx.warn(`Failed to open sword shop: ${result.message}`);
        return null;
    }

    await new Promise(r => setTimeout(r, 500));
    ctx.log('Sword shop opened');

    // Check what we can afford
    for (const sword of SWORDS) {
        if (budget < sword.price * 1.1) continue;  // 10% margin for safety

        const shop = ctx.state()?.shop;
        if (!shop?.isOpen) break;

        const shopItem = shop.shopItems.find(i => sword.pattern.test(i.name));
        if (!shopItem || shopItem.count === 0) continue;

        ctx.log(`Buying ${shopItem.name} for ~${sword.price} GP...`);
        const buyResult = await ctx.bot.buyFromShop(shopItem, 1);

        if (buyResult.success) {
            ctx.log(`Bought ${buyResult.item?.name}!`);
            await ctx.bot.closeShop();
            return buyResult.item?.name ?? shopItem.name;
        } else {
            ctx.log(`Failed to buy: ${buyResult.message}`);
        }
        ctx.progress();
    }

    ctx.log('No affordable swords in shop');
    await ctx.bot.closeShop();
    return null;
}

async function buyArmor(ctx: ScriptContext, budget: number): Promise<string[]> {
    ctx.log(`=== Buying armor (budget: ${budget} GP) ===`);
    const purchased: string[] = [];
    const slotsBought = new Set<string>();

    // Open shop
    const result = await ctx.bot.openShop(/shop/i);
    if (!result.success) {
        ctx.warn(`Failed to open armor shop: ${result.message}`);
        return purchased;
    }

    await new Promise(r => setTimeout(r, 500));
    ctx.log('Armor shop opened');

    let remainingBudget = budget;

    // Try to buy one of each slot
    for (const armor of ARMOR) {
        if (slotsBought.has(armor.slot)) continue;  // Already have this slot
        if (remainingBudget < armor.price * 1.1) continue;  // Can't afford

        const shop = ctx.state()?.shop;
        if (!shop?.isOpen) break;

        const shopItem = shop.shopItems.find(i => armor.pattern.test(i.name));
        if (!shopItem || shopItem.count === 0) continue;

        ctx.log(`Buying ${shopItem.name} for ~${armor.price} GP...`);
        const buyResult = await ctx.bot.buyFromShop(shopItem, 1);

        if (buyResult.success) {
            ctx.log(`Bought ${buyResult.item?.name}!`);
            purchased.push(buyResult.item?.name ?? shopItem.name);
            slotsBought.add(armor.slot);
            remainingBudget -= armor.price;
        } else {
            ctx.log(`Failed to buy: ${buyResult.message}`);
        }
        ctx.progress();
    }

    await ctx.bot.closeShop();
    return purchased;
}

async function equipAllGear(ctx: ScriptContext): Promise<string[]> {
    ctx.log('=== Equipping all new gear ===');
    const equipped: string[] = [];

    const inventory = ctx.state()?.inventory ?? [];

    // Find and equip weapons
    const weapons = inventory.filter(i =>
        /sword|scimitar|longsword|dagger/i.test(i.name) &&
        i.optionsWithIndex.some(o => /wield|wear|equip/i.test(o.text))
    );

    for (const weapon of weapons) {
        ctx.log(`Equipping weapon: ${weapon.name}`);
        const result = await ctx.bot.equipItem(weapon);
        if (result.success) {
            equipped.push(weapon.name);
        }
        await new Promise(r => setTimeout(r, 300));
        ctx.progress();
    }

    // Find and equip armor
    const armor = inventory.filter(i =>
        /chain|plate|helm|leg|boots|shield/i.test(i.name) &&
        i.optionsWithIndex.some(o => /wield|wear|equip/i.test(o.text))
    );

    for (const piece of armor) {
        ctx.log(`Equipping armor: ${piece.name}`);
        const result = await ctx.bot.equipItem(piece);
        if (result.success) {
            equipped.push(piece.name);
        }
        await new Promise(r => setTimeout(r, 300));
        ctx.progress();
    }

    return equipped;
}

async function takeVictoryScreenshot(ctx: ScriptContext): Promise<void> {
    ctx.log('=== Taking victory screenshot ===');

    // Get the page from session
    const session = ctx.session;
    const page = session.page;

    // Take screenshot and save to file
    const screenshotPath = '/Users/max/workplace/rs-agent/Server/bot_arcs/Adam_2/victory.png';
    await page.screenshot({ path: screenshotPath, type: 'png' });
    ctx.log(`Victory screenshot saved to: ${screenshotPath}`);

    // Also save using ctx.screenshot for the run log
    await ctx.screenshot('VICTORY');
}

runArc({
    characterName: 'Adam_2',
    arcName: 'final-mission',
    goal: 'Cash out hides, buy gear, take victory screenshot',
    timeLimit: 15 * 60 * 1000,  // 15 minutes max
    stallTimeout: 120_000,      // 2 minutes stall timeout
    screenshotInterval: 30_000,
    launchOptions: {
        useSharedBrowser: false,
        headless: false,
    },
}, async (ctx) => {
    // Step 0: Wait for state
    if (!await waitForGameState(ctx)) {
        ctx.error('Failed to load game state');
        return;
    }

    const startState = ctx.state()!;
    ctx.log('');
    ctx.log('=== FINAL MISSION: GEAR UP AND SCREENSHOT ===');
    ctx.log(`Starting position: (${startState.player?.worldX}, ${startState.player?.worldZ})`);
    ctx.log(`Total Level: ${getTotalLevel(ctx)}`);
    ctx.log(`GP: ${getCoins(ctx)}`);
    ctx.log(`Inventory: ${startState.inventory.length} items`);
    ctx.log('');

    // Dismiss any blocking UI
    await ctx.bot.dismissBlockingUI();
    ctx.progress();

    // Step 1: Walk to Draynor Bank (where hides are stored)
    ctx.log('');
    ctx.log('=== STEP 1: Walk to Draynor Bank ===');
    const playerStart = ctx.state()?.player;
    const distToDraynor = Math.sqrt(
        Math.pow((playerStart?.worldX ?? 0) - LOCATIONS.DRAYNOR_BANK.x, 2) +
        Math.pow((playerStart?.worldZ ?? 0) - LOCATIONS.DRAYNOR_BANK.z, 2)
    );
    ctx.log(`Current position: (${playerStart?.worldX}, ${playerStart?.worldZ})`);
    ctx.log(`Distance to Draynor Bank: ${distToDraynor.toFixed(0)}`);

    if (distToDraynor > 10) {
        // Use waypoints to avoid Dark Wizards
        const waypoints = [
            { x: 3230, z: 3270 },  // West from chicken farm
            { x: 3200, z: 3260 },  // Continue west
            { x: 3170, z: 3250 },  // Southwest
            { x: 3140, z: 3245 },  // Approaching Draynor
            { x: 3110, z: 3243 },  // Almost there
            { x: 3092, z: 3243 },  // Draynor Bank
        ];

        for (const wp of waypoints) {
            ctx.log(`Walking to waypoint (${wp.x}, ${wp.z})...`);
            try {
                const result = await ctx.bot.walkTo(wp.x, wp.z, 5);
                ctx.log(`Walk result: ${result.message}`);

                // Check if close enough
                const pos = ctx.state()?.player;
                const dist = Math.sqrt(
                    Math.pow((pos?.worldX ?? 0) - LOCATIONS.DRAYNOR_BANK.x, 2) +
                    Math.pow((pos?.worldZ ?? 0) - LOCATIONS.DRAYNOR_BANK.z, 2)
                );
                if (dist < 15) {
                    ctx.log('Close enough to bank, stopping waypoint walk');
                    break;
                }
            } catch (e) {
                ctx.warn(`Waypoint walk error: ${e}`);
            }
            ctx.progress();
            await new Promise(r => setTimeout(r, 500));
        }
    } else {
        ctx.log(`Already near Draynor Bank`);
    }

    // Step 2: Withdraw all cowhides as notes
    ctx.log('');
    ctx.log('=== STEP 2: Withdraw cowhides from bank ===');
    await openBankAndWithdraw(ctx);

    // Step 3: Walk to Lumbridge General Store
    ctx.log('');
    ctx.log('=== STEP 3: Walk to Lumbridge General Store ===');
    const walkResult2 = await ctx.bot.walkTo(LOCATIONS.LUMBRIDGE_GEN_STORE.x, LOCATIONS.LUMBRIDGE_GEN_STORE.z);
    ctx.log(`Walk to store: ${walkResult2.message}`);

    // Step 4: Sell all hides
    ctx.log('');
    ctx.log('=== STEP 4: Sell all cowhides ===');
    const goldEarned = await sellAtGeneralStore(ctx);
    ctx.log(`Total gold after selling: ${getCoins(ctx)} GP`);

    // Calculate budget split
    const totalGold = getCoins(ctx);
    const swordBudget = Math.floor(totalGold * 0.6);  // 60% for sword
    const armorBudget = totalGold - swordBudget;       // 40% for armor

    ctx.log(`Budget split: ${swordBudget} GP for sword, ${armorBudget} GP for armor`);

    // If no gold, skip shopping and go straight to screenshot
    if (totalGold < 50) {
        ctx.log('');
        ctx.log('=== NOT ENOUGH GOLD - SKIPPING SHOPPING ===');
        ctx.log('Taking victory screenshot with current equipment...');

        // Walk to a nice location for the screenshot (Lumbridge castle courtyard)
        await ctx.bot.walkTo(3222, 3218, 10);
        await takeVictoryScreenshot(ctx);

        // Final summary
        ctx.log('');
        ctx.log('==========================================');
        ctx.log('     MISSION COMPLETE (No Gold Version)   ');
        ctx.log('==========================================');

        const finalState = ctx.state()!;
        ctx.log(`Position: (${finalState.player?.worldX}, ${finalState.player?.worldZ})`);
        ctx.log(`Total Level: ${getTotalLevel(ctx)}`);
        ctx.log(`GP: ${getCoins(ctx)}`);
        ctx.log('');
        ctx.log('=== COMBAT STATS ===');
        const atk = ctx.sdk.getSkill('Attack');
        const str = ctx.sdk.getSkill('Strength');
        const def = ctx.sdk.getSkill('Defence');
        const hp = ctx.sdk.getSkill('Hitpoints');
        ctx.log(`Attack: ${atk?.baseLevel}`);
        ctx.log(`Strength: ${str?.baseLevel}`);
        ctx.log(`Defence: ${def?.baseLevel}`);
        ctx.log(`Hitpoints: ${hp?.baseLevel}`);
        ctx.log('');
        ctx.log('=== EQUIPMENT ===');
        const equipment = finalState.equipment ?? [];
        for (const e of equipment) {
            ctx.log(`  - ${e.name}`);
        }
        ctx.log('');
        ctx.log('Note: Could not afford gear upgrades. Still rocking bronze!');
        ctx.log('Victory screenshot saved to: /Users/max/workplace/rs-agent/Server/bot_arcs/Adam_2/victory.png');
        return;
    }

    // Step 5: Walk to Varrock Sword Shop
    ctx.log('');
    ctx.log('=== STEP 5: Walk to Varrock Sword Shop ===');
    // The sword shop is actually at ~3204, 3399 (south of west bank)
    const swordShopCoords = { x: 3204, z: 3399 };
    const walkResult3 = await ctx.bot.walkTo(swordShopCoords.x, swordShopCoords.z);
    ctx.log(`Walk to sword shop: ${walkResult3.message}`);

    // Step 6: Buy best sword
    ctx.log('');
    ctx.log('=== STEP 6: Buy best affordable sword ===');
    const swordPurchased = await buyBestSword(ctx, swordBudget);
    if (swordPurchased) {
        ctx.log(`SWORD PURCHASED: ${swordPurchased}`);
    } else {
        ctx.warn('No sword purchased');
    }

    // Step 7: Walk to Varrock Armor Shop (Horvik's)
    ctx.log('');
    ctx.log('=== STEP 7: Walk to Varrock Armor Shop ===');
    const walkResult4 = await ctx.bot.walkTo(LOCATIONS.VARROCK_ARMOR_SHOP.x, LOCATIONS.VARROCK_ARMOR_SHOP.z);
    ctx.log(`Walk to armor shop: ${walkResult4.message}`);

    // Step 8: Buy armor
    ctx.log('');
    ctx.log('=== STEP 8: Buy armor ===');
    const remainingGold = getCoins(ctx);
    const armorPurchased = await buyArmor(ctx, remainingGold);
    ctx.log(`ARMOR PURCHASED: ${armorPurchased.join(', ') || 'none'}`);

    // Step 9: Equip all gear
    ctx.log('');
    ctx.log('=== STEP 9: Equip all new gear ===');
    const equipped = await equipAllGear(ctx);
    ctx.log(`EQUIPPED: ${equipped.join(', ') || 'nothing new'}`);

    // Step 10: Take victory screenshot
    ctx.log('');
    ctx.log('=== STEP 10: Victory screenshot! ===');
    await takeVictoryScreenshot(ctx);

    // Final summary
    ctx.log('');
    ctx.log('==========================================');
    ctx.log('          MISSION COMPLETE!              ');
    ctx.log('==========================================');
    ctx.log('');

    const finalState = ctx.state()!;
    ctx.log('=== FINAL STATS ===');
    ctx.log(`Position: (${finalState.player?.worldX}, ${finalState.player?.worldZ})`);
    ctx.log(`Total Level: ${getTotalLevel(ctx)}`);
    ctx.log(`GP remaining: ${getCoins(ctx)}`);
    ctx.log('');

    ctx.log('=== COMBAT STATS ===');
    const atk = ctx.sdk.getSkill('Attack');
    const str = ctx.sdk.getSkill('Strength');
    const def = ctx.sdk.getSkill('Defence');
    const hp = ctx.sdk.getSkill('Hitpoints');
    ctx.log(`Attack: ${atk?.baseLevel}`);
    ctx.log(`Strength: ${str?.baseLevel}`);
    ctx.log(`Defence: ${def?.baseLevel}`);
    ctx.log(`Hitpoints: ${hp?.baseLevel}`);
    ctx.log('');

    ctx.log('=== EQUIPMENT ===');
    const equipment = finalState.equipment ?? [];
    for (const e of equipment) {
        ctx.log(`  - ${e.name}`);
    }
    ctx.log('');

    ctx.log('=== ITEMS PURCHASED ===');
    if (swordPurchased) ctx.log(`  - ${swordPurchased}`);
    for (const a of armorPurchased) ctx.log(`  - ${a}`);
    ctx.log('');

    ctx.log('Victory screenshot saved to: /Users/max/workplace/rs-agent/Server/bot_arcs/Adam_2/victory.png');
    ctx.log('');
    ctx.log('MISSION COMPLETE - DO NOT LOOP');
});
