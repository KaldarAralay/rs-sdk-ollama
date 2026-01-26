/**
 * Adam_4 Final Mission - Gear Up and Screenshot
 *
 * Steps:
 * 1. Go to Varrock West Bank (3185, 3436) using waypoints
 * 2. Withdraw ALL cowhides
 * 3. Walk to Lumbridge General Store (3212, 3246)
 * 4. Sell cowhides
 * 5. Walk to Varrock Sword Shop (3203, 3398) - buy best sword
 * 6. Walk to Varrock Armor Shop - buy armor with remaining gold
 * 7. Equip all new gear
 * 8. Take victory screenshot
 */

import { launchBotWithSDK, sleep } from '../../test/utils/browser';
import type { SDKSession } from '../../test/utils/browser';

const BOT_NAME = 'adam_4';

// Locations
const LOCATIONS = {
    COW_FIELD: { x: 3253, z: 3270 },
    VARROCK_WEST_BANK: { x: 3185, z: 3436 },
    LUMBRIDGE_GENERAL_STORE: { x: 3211, z: 3247 },
    VARROCK_SWORD_SHOP: { x: 3203, z: 3398 },
    VARROCK_ARMOR_SHOP: { x: 3209, z: 3503 }, // Horvik's
};

// Waypoints from cow field to Varrock West Bank (proven route)
const WAYPOINTS_COW_TO_BANK = [
    { x: 3253, z: 3280 },  // North of cow field
    { x: 3250, z: 3310 },  // Continue north
    { x: 3250, z: 3340 },  // North towards Varrock
    { x: 3245, z: 3370 },  // Approaching Varrock south
    { x: 3230, z: 3400 },  // Varrock south entrance
    { x: 3210, z: 3420 },  // Into Varrock
    { x: 3185, z: 3436 },  // Varrock West Bank
];

// Waypoints from bank to Lumbridge general store
const WAYPOINTS_BANK_TO_LUM_STORE = [
    { x: 3210, z: 3420 },  // East from bank
    { x: 3230, z: 3400 },  // South of Varrock
    { x: 3230, z: 3350 },  // Continue south
    { x: 3230, z: 3300 },  // Past midway
    { x: 3230, z: 3260 },  // Near Lumbridge
    { x: 3211, z: 3247 },  // General store
];

// Waypoints from Lumbridge to Varrock sword shop
const WAYPOINTS_LUM_TO_SWORD_SHOP = [
    { x: 3220, z: 3260 },  // North of Lumbridge
    { x: 3210, z: 3290 },  // North more
    { x: 3200, z: 3320 },  // Midway
    { x: 3200, z: 3350 },  // Past Dark Wizards (go west to avoid)
    { x: 3200, z: 3380 },  // Approaching Varrock
    { x: 3203, z: 3398 },  // Sword shop
];

// Waypoints from sword shop to armor shop (north in Varrock)
const WAYPOINTS_SWORD_TO_ARMOR = [
    { x: 3200, z: 3420 },  // North in Varrock
    { x: 3200, z: 3450 },  // Continue north
    { x: 3200, z: 3480 },  // Near armor shop
    { x: 3209, z: 3503 },  // Horvik's armor shop
];

async function walkWaypoints(
    ctx: { sdk: any; bot: any },
    waypoints: Array<{ x: number; z: number }>,
    description: string
): Promise<boolean> {
    console.log(`Walking ${description}...`);

    for (let i = 0; i < waypoints.length; i++) {
        const wp = waypoints[i];
        if (!wp) continue;
        console.log(`  Waypoint ${i + 1}/${waypoints.length}: (${wp.x}, ${wp.z})`);

        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await ctx.bot.walkTo(wp.x, wp.z);
                await sleep(1500);

                const player = ctx.sdk.getState()?.player;
                if (!player || player.worldX === 0) continue;

                const dist = Math.sqrt(
                    Math.pow(player.worldX - wp.x, 2) +
                    Math.pow(player.worldZ - wp.z, 2)
                );

                if (dist <= 15) {
                    console.log(`    Reached (${player.worldX}, ${player.worldZ})`);
                    break;
                }
                console.log(`    Attempt ${attempt + 1}: ${dist.toFixed(0)} tiles away`);
            } catch (err) {
                console.log(`    Walk error, retrying...`);
                await sleep(1000);
            }
        }

        // Dismiss any dialogs
        const state = ctx.sdk.getState();
        if (state?.dialog?.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            await sleep(500);
        }
    }
    return true;
}

async function main() {
    console.log('=== ADAM_4 FINAL MISSION: GEAR UP ===');

    let session: SDKSession | null = null;

    try {
        // Launch with existing bot - NO shared browser
        console.log(`Launching bot ${BOT_NAME}...`);
        session = await launchBotWithSDK(BOT_NAME, {
            headless: false,
            skipTutorial: false,
            useSharedBrowser: false,
        });

        const { sdk, bot, page } = session;

        // Wait for game state to stabilize
        console.log('Waiting for game state to sync...');
        await sleep(3000);

        // Wait for valid position
        let attempts = 0;
        while (attempts < 20) {
            const s = sdk.getState();
            if (s?.player?.worldX && s.player.worldX > 0) {
                console.log(`State synced at position (${s.player.worldX}, ${s.player.worldZ})`);
                break;
            }
            await sleep(500);
            attempts++;
        }

        const state = sdk.getState();
        if (!state) throw new Error('No game state');

        console.log(`Starting position: (${state.player?.worldX}, ${state.player?.worldZ})`);
        console.log(`Inventory: ${state.inventory.length} items`);
        const startGold = state.inventory.find(i => i.name.toLowerCase().includes('coin'))?.count || 0;
        console.log(`Starting Gold: ${startGold} gp`);

        // Log starting equipment
        console.log(`Equipment: ${state.equipment.map(e => e.name).join(', ') || 'None'}`);

        // ===== STEP 1: Go to Varrock West Bank =====
        console.log('\n=== STEP 1: Walk to Varrock West Bank ===');
        await walkWaypoints({ sdk, bot }, WAYPOINTS_COW_TO_BANK, 'to Varrock West Bank');

        // ===== STEP 2: Open bank and withdraw cowhides =====
        console.log('\n=== STEP 2: Open bank and withdraw cowhides ===');

        // Find and use bank booth
        let bankState = sdk.getState();
        const bankBooth = bankState?.nearbyLocs.find((l: any) => /bank booth/i.test(l.name));
        if (bankBooth) {
            console.log(`Found bank booth at (${bankBooth.x}, ${bankBooth.z})`);
            const bankOpt = bankBooth.optionsWithIndex.find((o: any) => /bank/i.test(o.text));
            if (bankOpt) {
                await sdk.sendInteractLoc(bankBooth.x, bankBooth.z, bankBooth.id, bankOpt.opIndex);
                await sleep(2000);
            }
        } else {
            console.log('No bank booth found, nearby locs:', bankState?.nearbyLocs.slice(0, 5).map((l: any) => l.name));
        }

        // Wait for bank interface
        let bankOpen = false;
        for (let i = 0; i < 10; i++) {
            const s = sdk.getState();
            if (s?.interface?.isOpen) {
                bankOpen = true;
                console.log(`Bank interface opened!`);
                break;
            }
            await sleep(500);
        }

        if (bankOpen) {
            // Withdraw all items (try multiple slots)
            console.log('Withdrawing all bank items...');
            for (let slot = 0; slot < 15; slot++) {
                try {
                    await sdk.sendBankWithdraw(slot, 999);
                    await sleep(150);
                } catch (e) {
                    // Slot empty or error
                }
            }
            await sleep(1000);

            // Walk away to close bank
            console.log('Closing bank...');
            await bot.walkTo(LOCATIONS.VARROCK_WEST_BANK.x + 5, LOCATIONS.VARROCK_WEST_BANK.z);
            await sleep(1000);
        }

        // Check inventory
        const afterBank = sdk.getState();
        const hides = afterBank?.inventory.filter((i: any) => /cow\s*hide/i.test(i.name)) || [];
        const totalHides = hides.reduce((sum: number, h: any) => sum + h.count, 0);
        const goldAfterBank = afterBank?.inventory.find((i: any) => /coin/i.test(i.name))?.count || 0;
        console.log(`After bank: ${totalHides} cowhides, ${goldAfterBank} gp`);
        console.log(`Full inventory: ${afterBank?.inventory.map((i: any) => `${i.name}(${i.count})`).join(', ')}`);

        if (totalHides > 0) {
            // ===== STEP 3: Walk to Lumbridge General Store =====
            console.log('\n=== STEP 3: Walk to Lumbridge General Store ===');
            await walkWaypoints({ sdk, bot }, WAYPOINTS_BANK_TO_LUM_STORE, 'to Lumbridge General Store');

            // ===== STEP 4: Sell cowhides =====
            console.log('\n=== STEP 4: Sell cowhides ===');

            const storeState = sdk.getState();
            const shopkeeper = storeState?.nearbyNpcs.find((n: any) => /shop/i.test(n.name));
            if (shopkeeper) {
                console.log(`Found: ${shopkeeper.name}`);
                const tradeOpt = shopkeeper.optionsWithIndex.find((o: any) => /trade/i.test(o.text));
                if (tradeOpt) {
                    await sdk.sendInteractNpc(shopkeeper.index, tradeOpt.opIndex);
                    await sleep(2000);
                }
            } else {
                console.log('NPCs nearby:', storeState?.nearbyNpcs.slice(0, 5).map((n: any) => n.name));
            }

            // Sell items
            const shopState = sdk.getState();
            if (shopState?.shop?.isOpen) {
                console.log(`Shop open: ${shopState.shop.title}`);
                const hidesInv = shopState.inventory.filter((i: any) => /cow\s*hide/i.test(i.name));
                for (const hide of hidesInv) {
                    console.log(`Selling ${hide.count} ${hide.name}...`);
                    await sdk.sendShopSell(hide.slot, hide.count);
                    await sleep(300);
                }
                await sdk.sendCloseShop();
                await sleep(500);
            }
        }

        // Check gold after selling
        const afterSell = sdk.getState();
        const goldAfterSell = afterSell?.inventory.find((i: any) => /coin/i.test(i.name))?.count || 0;
        console.log(`Gold after selling: ${goldAfterSell} gp`);

        // ===== STEP 5: Go to Varrock Sword Shop =====
        console.log('\n=== STEP 5: Walk to Varrock Sword Shop ===');
        await walkWaypoints({ sdk, bot }, WAYPOINTS_LUM_TO_SWORD_SHOP, 'to Varrock Sword Shop');

        // Open sword shop
        const swordState = sdk.getState();
        const swordNpc = swordState?.nearbyNpcs.find((n: any) =>
            /sword|shop|zaff/i.test(n.name)
        );
        if (swordNpc) {
            console.log(`Found: ${swordNpc.name}`);
            const tradeOpt = swordNpc.optionsWithIndex.find((o: any) => /trade/i.test(o.text));
            if (tradeOpt) {
                await sdk.sendInteractNpc(swordNpc.index, tradeOpt.opIndex);
                await sleep(2000);
            }
        } else {
            console.log('NPCs nearby:', swordState?.nearbyNpcs.slice(0, 5).map((n: any) => n.name));
        }

        // Buy sword
        const swordShopState = sdk.getState();
        if (swordShopState?.shop?.isOpen) {
            console.log(`Shop: ${swordShopState.shop.title}`);
            console.log(`Items: ${swordShopState.shop.shopItems.map((i: any) => i.name).join(', ')}`);

            // Try to buy swords (steel > iron > bronze)
            const swordPriority = ['Steel sword', 'Steel longsword', 'Iron sword', 'Iron longsword', 'Bronze sword'];
            for (const swordName of swordPriority) {
                const sword = swordShopState.shop.shopItems.find((i: any) =>
                    i.name.toLowerCase() === swordName.toLowerCase()
                );
                if (sword && sword.count > 0) {
                    console.log(`Buying ${sword.name}...`);
                    await sdk.sendShopBuy(sword.slot, 1);
                    await sleep(500);
                    break;
                }
            }
            await sdk.sendCloseShop();
            await sleep(500);
        }

        // ===== STEP 6: Go to Varrock Armor Shop =====
        console.log('\n=== STEP 6: Walk to Varrock Armor Shop ===');
        await walkWaypoints({ sdk, bot }, WAYPOINTS_SWORD_TO_ARMOR, 'to Varrock Armor Shop');

        // Open armor shop
        const armorState = sdk.getState();
        const armorNpc = armorState?.nearbyNpcs.find((n: any) =>
            /horvik|armour|armor|shop/i.test(n.name)
        );
        if (armorNpc) {
            console.log(`Found: ${armorNpc.name}`);
            const tradeOpt = armorNpc.optionsWithIndex.find((o: any) => /trade/i.test(o.text));
            if (tradeOpt) {
                await sdk.sendInteractNpc(armorNpc.index, tradeOpt.opIndex);
                await sleep(2000);
            }
        } else {
            console.log('NPCs nearby:', armorState?.nearbyNpcs.slice(0, 5).map((n: any) => n.name));
        }

        // Buy armor
        const armorShopState = sdk.getState();
        if (armorShopState?.shop?.isOpen) {
            console.log(`Shop: ${armorShopState.shop.title}`);
            console.log(`Items: ${armorShopState.shop.shopItems.map((i: any) => i.name).join(', ')}`);

            // Buy what we can afford
            const armorPriority = [
                'Steel platebody', 'Iron platebody', 'Bronze platebody',
                'Steel platelegs', 'Iron platelegs', 'Bronze platelegs',
                'Steel chainbody', 'Iron chainbody', 'Bronze chainbody',
                'Steel med helm', 'Iron med helm', 'Bronze med helm'
            ];
            for (const armorName of armorPriority) {
                const armor = armorShopState.shop.shopItems.find((i: any) =>
                    i.name.toLowerCase() === armorName.toLowerCase()
                );
                if (armor && armor.count > 0) {
                    console.log(`Buying ${armor.name}...`);
                    await sdk.sendShopBuy(armor.slot, 1);
                    await sleep(500);
                }
            }
            await sdk.sendCloseShop();
            await sleep(500);
        }

        // ===== STEP 7: Equip all gear =====
        console.log('\n=== STEP 7: Equip all gear ===');
        const equipState = sdk.getState();
        const equipableItems = equipState?.inventory.filter((i: any) =>
            /sword|scimitar|dagger|axe|mace|chainbody|platebody|platelegs|plateskirt|helm|shield|body|legs/i.test(i.name)
        ) || [];

        for (const item of equipableItems) {
            console.log(`Equipping ${item.name}...`);
            await bot.equipItem(item);
            await sleep(500);
        }

        // ===== STEP 8: Take victory screenshot =====
        console.log('\n=== STEP 8: Taking victory screenshot ===');
        await sleep(1000);

        await page.screenshot({
            type: 'png',
            path: '/Users/max/workplace/rs-agent/Server/bot_arcs/Adam_4/victory.png'
        });
        console.log('Victory screenshot saved!');

        // Log final stats
        const finalState = sdk.getState();
        console.log('\n========== FINAL STATS ==========');
        console.log(`Position: (${finalState?.player?.worldX}, ${finalState?.player?.worldZ})`);
        console.log(`Combat Level: ${finalState?.player?.combatLevel}`);
        console.log(`Equipment: ${finalState?.equipment.map((e: any) => e.name).join(', ') || 'None'}`);

        const finalGold = finalState?.inventory.find((i: any) => /coin/i.test(i.name))?.count || 0;
        console.log(`Gold: ${finalGold} gp`);

        // Skills
        console.log('\nSkills:');
        for (const skill of finalState?.skills || []) {
            if (skill.baseLevel > 1) {
                console.log(`  ${skill.name}: ${skill.baseLevel}`);
            }
        }

        // Calculate score
        const totalLevel = finalState?.skills.reduce((sum: number, s: any) => sum + s.baseLevel, 0) || 0;
        console.log(`\n=== SCORE: ${totalLevel + finalGold} (TL ${totalLevel} + ${finalGold} GP) ===`);
        console.log('========== MISSION COMPLETE ==========');

        // Keep browser open
        console.log('\nKeeping browser open for 30 seconds...');
        await sleep(30000);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        if (session) {
            await session.cleanup();
        }
    }
}

main().catch(console.error);
