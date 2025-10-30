// index.js

// 1. Corrected dotenv import for ES Module syntax
import 'dotenv/config'; 

// 2. Corrected discord.js import for ES Module syntax
import { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    REST, 
    Routes, 
    PermissionsBitField,
    ActionRowBuilder, 
    ButtonBuilder,   
    ButtonStyle      
} from 'discord.js';

// 3. Corrected local file import for ES Module syntax (must include .js extension)
import GameManager from './game_logic/GameManager.js'; 

// --- Configuration ---
const TOKEN = process.env.DISCORD_TOKEN;

// --- Suit Emoji and Card Display Helpers ---
const SUIT_EMOJIS = {
    'S': '♠️',
    'H': '♥️',
    'D': '♦️',
    'C': '♣️'
};

/**
 * Formats a Card object for display with suit emojis.
 * Assumes Card object has rankCode (e.g., 'A', 'T') and suitCode (e.g., 'S', 'H').
 * @param {object} card - The Card object.
 * @returns {string} The formatted display string (e.g., "A♠️").
 */
const getCardEmojiDisplay = (card) => {
    // Adjust 'T' (for 10) to '10' for better user readability based on Deck.js
    const rank = card.rankCode === 'T' ? '10' : card.rankCode;
    return `${rank}${SUIT_EMOJIS[card.suitCode] || card.suitCode}`; // Fallback to letter if emoji missing
};


// --- Helper Function for Lobby Button ---
/**
 * Creates the ActionRow with the Join Game button, dynamically labeled with player count.
 * @param {number} playerCount - The number of players currently in the lobby.
 * @returns {ActionRowBuilder[]} An array containing a single ActionRow.
 */
const createLobbyComponents = (channelId, playerCount = 0) => {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`join_game:${channelId}`)
                .setLabel(`Join Game (${playerCount}/4)`)
                .setStyle(ButtonStyle.Success)
                .setDisabled(playerCount >= 4)
        )
    ];
};

// --- Helper Function for Bidding Buttons ---
/**
 * Creates the bidding buttons, embedding the gameChannelId into the customId for reliable lookup.
 * @param {string} gameChannelId - The ID of the guild channel where the game is running.
 * @returns {ActionRowBuilder[]} An array containing the ActionRows with bidding buttons.
 */
const createBiddingComponents = (gameChannelId) => {
    const buttons = [];

    // 1 to 13 tricks, plus Nil
    for (let i = 1; i <= 13; i++) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`bid_${gameChannelId}_${i}`)
                .setLabel(`${i}`)
                .setStyle(ButtonStyle.Primary)
        );
    }

    // Add Nil button separately
    buttons.push(
        new ButtonBuilder()
            .setCustomId(`bid_${gameChannelId}_nil`)
            .setLabel('Nil (0)')
            .setStyle(ButtonStyle.Danger)
    );

    // Split 14 buttons into 3 rows (5, 5, 4)
    const row1 = new ActionRowBuilder().addComponents(buttons.slice(0, 5));
    const row2 = new ActionRowBuilder().addComponents(buttons.slice(5, 10));
    const row3 = new ActionRowBuilder().addComponents(buttons.slice(10, 14));

    return [row1, row2, row3];
};


// Command definitions
const commands = [
    new SlashCommandBuilder()
        .setName('spades')
        .setDescription('Spades card game commands.')
        .addSubcommand(subcommand =>
            // REFLECTING LOBBY CHANGE: No options needed, users join via button
            subcommand.setName('start')
                .setDescription('Starts a new Spades lobby in this channel. Players join via a button.')
        )
        .addSubcommand(subcommand =>
            subcommand.setName('hand')
                .setDescription('View your current hand (sent privately).')
        )
        .addSubcommand(subcommand =>
            subcommand.setName('play')
                .setDescription('Play a card to the current trick.')
                .addStringOption(option => option.setName('card').setDescription('The card to play (e.g., AS for Ace of Spades, C10 for 10 of Clubs).').setRequired(true))
        )
        .addSubcommand(subcommand =>
            subcommand.setName('status')
                .setDescription('Show the current game status, bids, and scores.')
        ),
].map(command => command.toJSON());

// --- Bot Setup ---

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Map to store active games: key is channelId, value is GameManager instance.
const activeGames = new Map();

// --- Command Deployment ---
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    const botId = client.user.id; // Use the client's actual ID here
    console.log(`Bot ID: ${botId}`);

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        console.log('Started refreshing application (/) commands.');
        // Register commands globally using client.user.id
        await rest.put(
            Routes.applicationCommands(botId),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
});


/**
 * Sends the hands and bidding buttons to all players via DM.
 * This is called when the lobby fills up or when a new round starts.
 * @param {GameManager} game - The active game instance.
 * @param {object} channel - The Discord channel object for public announcements.
 * @param {string} gameChannelId - The ID of the guild channel where the game is running.
 */
const sendHandsAndBiddingButtons = async (game, channel, gameChannelId) => {
  const dmFailedPlayers = [];
  const biddingComponents = createBiddingComponents(gameChannelId);
  const gameChannelName = channel ? channel.name : 'a server channel';

  const firstBidder = game.players[game.currentPlayerIndex].username;

  // Public announcement
  if (channel) {
    await channel.send({
      content: `📢 **Bidding has started!** It is **${firstBidder}**'s turn to bid first! Please check your DMs for your hand and bid buttons.`,
      embeds: [
        new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle('Player Order & Bids')
          .setDescription(game.players.map(p => `**${p.username}**`).join(' -> '))
      ]
    });
  }

  // DM each player their hand and bid buttons
  for (const player of game.players) {
    try {
      const user = await client.users.fetch(player.discordId);
      const handDisplay = player.getPrettyHand(); // Uses grouped suit layout

      await user.send({
        content: `🃏 **Your Spades Hand**\nYou are playing in **#${gameChannelName}**.\nSelect your bid using the buttons below.\n\n${handDisplay}`,
        components: biddingComponents
      });
    } catch (err) {
      console.error(`❌ Could not send DM to ${player.username}:`, err);
      dmFailedPlayers.push(player.username);
    }
  }

  // Optional: notify if any DMs failed
  if (dmFailedPlayers.length && channel) {
    await channel.send(`⚠️ Could not send DMs to: ${dmFailedPlayers.join(', ')}`);
  }
};

// --- Interaction Handling ---
client.on('interactionCreate', async interaction => {
    // NOTE: channelId here is the GUILD channel ID for slash commands,
    // but the DM channel ID for bid buttons (hence the lookup fix below).
    const { user, channelId, options } = interaction;
    const game = activeGames.get(channelId); // Only successful for guild-based interactions

 // ----------------------------------------------------
// Handle Join Game Button Interaction (LOBBY)
// ----------------------------------------------------
if (interaction.isButton() && interaction.customId.startsWith('join_game')) {
    const [, gameChannelId] = interaction.customId.split(':');

    // 🔍 Debug logs to trace the issue
    console.log('🔘 Join button clicked by:', interaction.user.username);
    console.log('📎 Button customId:', interaction.customId);
    console.log('📨 Parsed gameChannelId:', gameChannelId);
    console.log('📚 Available game keys in activeGames:', [...activeGames.keys()]);
    console.log('📍 interaction.channelId:', interaction.channelId);
    console.log('📍 interaction.message.channelId:', interaction.message?.channelId);
    console.log('📍 interaction.channel.id:', interaction.channel?.id);

    const game = activeGames.get(gameChannelId);

    if (!game || game.state !== 'LOBBY') {
        console.log('🚫 Game not found or not in LOBBY state.');
        return interaction.reply({ content: 'That game lobby is no longer active or has already started!', ephemeral: true });
    }

    const playerDetails = {
        id: interaction.user.id,
        username: interaction.user.username,
        guildId: interaction.guildId
    };

    const result = game.addPlayer(playerDetails); // Assume GameManager has this method

    if (result.error) {
        return interaction.reply({ content: `🚫 Cannot join game: ${result.error}`, ephemeral: true });
    }

    // Successfully joined. Update the public message.
    const playerCount = game.players.length;
    const lobbyComponents = createLobbyComponents(gameChannelId, playerCount);
    const playerList = game.players.map(p => `\`${p.username}\``).join(', ');

    const joinMessage = `**${interaction.user.username}** joined the lobby! Current Players: ${playerList}`;

    // Edit the original message to update the player count on the button
    await interaction.update({
        content: `♠️ **Spades Lobby** - 4 players needed.\n\n${joinMessage}`,
        components: lobbyComponents,
        embeds: interaction.message.embeds // Keep any existing embeds
    });

    	if (game.isLobbyFull()) {
    	// Lobby is full, start the game!
        game.startGame(); // Deals cards, sets dealer, and sets state to BIDDING

        // Send DMs and start bidding sequence
        const channel = interaction.channel;
        await sendHandsAndBiddingButtons(game, channel, gameChannelId);

        // Final update to remove the 'Join Game' button after starting
        await interaction.editReply({
            content: '📢 **LOBBY FULL!** The game is starting now. Check your DMs for your hand!',
            components: [], // Remove all components
        });
    }

    return;
}


    // ----------------------------------------------------
    // Handle Bid Button Interaction (BIDDING)
    // ----------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('bid_')) {
    const parts = interaction.customId.split('_'); // Format: ['bid', <channelId>, <bidValue>]
    if (parts.length < 3) {
        return interaction.reply({ content: 'Invalid bid button format.', ephemeral: true });
    }

    const gameChannelId = parts[1];
    const bidAmount = parts[2] === 'nil' ? 0 : parseInt(parts[2], 10);
// 🔍 Debug logs
console.log('🔍 Parsed channel ID from button:', gameChannelId);
console.log('📚 Active game keys:', [...activeGames.keys()]);
    const gameForBid = activeGames.get(gameChannelId);

    if (!gameForBid || gameForBid.state !== 'BIDDING') {
        return interaction.reply({ content: 'No active Spades game found or bidding is complete.', ephemeral: true });
    }

    const player = gameForBid.players.find(p => p.discordId === interaction.user.id);

    if (!player) {
        return interaction.reply({ content: 'You are not a player in this game.', ephemeral: true });
    }

    const bidResult = gameForBid.tryPlaceBid(player.discordId, bidAmount);

    if (bidResult.error) {
        return interaction.reply({
            content: `🚫 Cannot place bid: ${bidResult.error}`,
            ephemeral: true
        });
    }

    const bidDisplay = bidResult.bidDisplay;
    const channel = await client.channels.fetch(gameChannelId).catch(console.error);

    await interaction.update({
        content: `✅ You successfully bid **${bidDisplay}**.\n\nWaiting for ${bidResult.bidsRemaining} more bids.`,
        embeds: interaction.message.embeds,
        components: []
    });

    const announceEmbed = new EmbedBuilder()
        .setColor('#1E90FF')
        .setDescription(`**${player.username}** bids **${bidDisplay}**!`);

    if (channel) {
        await channel.send({ embeds: [announceEmbed] });
    }

    if (bidResult.biddingComplete) {
        const firstPlayer = gameForBid.players[gameForBid.currentPlayerIndex].username;

        if (channel) {
            const biddingSummary = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('🚨 BIDDING COMPLETE! PLAYING PHASE STARTING! 🚨')
                .setDescription(`The first card is led by **${firstPlayer}**!`)
                .addFields({
                    name: 'Scores & Bids',
                    value: gameForBid.getTeamScoreDisplay(),
                    inline: false
                });

            await channel.send({
                embeds: [biddingSummary],
                content: `It is **${firstPlayer}**'s turn to play the first card. Use \`/spades play <card>\`.`
            });
        }
    } else {
        const nextBidder = gameForBid.players[gameForBid.currentPlayerIndex].username;
        if (channel) {
            await channel.send(`It is now **${nextBidder}**'s turn to bid. Please check your DMs.`);
        }
    }

    return;
}

    // ------------------------------------------------------------------------
    // SLASH COMMAND HANDLING SECTION
    // ------------------------------------------------------------------------

    // Use the modern, type-specific check for slash commands
    if (!interaction.isChatInputCommand()) return;

    // FIX: Define commandName by extracting it from the interaction object
    const commandName = interaction.commandName; 

    if (commandName !== 'spades') return;

    const subcommand = options.getSubcommand();

   // ----------------------------------------------------
// 1. /spades start (LOBBY INITIATION)
// ----------------------------------------------------
if (subcommand === 'start') {
    if (game) {
        return interaction.reply({ content: 'A game is already active in this channel.', ephemeral: true });
    }

    // The user initiating the command is the first player
    const initiator = {
        id: user.id,
        username: user.username,
        guildId: interaction.guildId
    };

    // Define communication hooks required by GameManager
    const publicAnnounce = (message) => {
        interaction.channel.send(message);
    };

    const privatePrompt = async (playerId, message) => {
        try {
            const user = await interaction.client.users.fetch(playerId);
            await user.send(message);
        } catch (err) {
            console.error(`Failed to DM player ${playerId}:`, err);
        }
    };

    // ✅ Create the new game instance and add the initiator properly
    const newGame = new GameManager(publicAnnounce, privatePrompt);
    newGame.channelId = channelId;
    newGame.state = 'LOBBY'; // Optional, if not already set in constructor

    const result = newGame.addPlayer(initiator);
    if (result.error) {
        return interaction.reply({ content: `🚫 Cannot join game: ${result.error}`, ephemeral: true });
    }

    activeGames.set(channelId, newGame);

    // Create lobby components with correct channel ID
    const lobbyComponents = createLobbyComponents(channelId, 1);
    const playerList = `\`${initiator.username}\``;

    await interaction.reply({ 
        content: `♠️ **A new Spades Lobby has been opened!** The game needs 4 players.\n\n` +
                 `Current Players: ${playerList}`, 
        components: lobbyComponents,
        ephemeral: false
    });

    return;
}


    // ----------------------------------------------------
    // 2. /spades hand
    // ----------------------------------------------------
if (interaction.isChatInputCommand() && interaction.commandName === 'spades') {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'hand') {
        const game = activeGames.get(interaction.channelId);

        if (!game) {
            return interaction.reply({
                content: '❌ No active Spades game found in this channel.',
                ephemeral: true
            });
        }

        const player = game.players.find(p => p.discordId === interaction.user.id);

        if (!player) {
            return interaction.reply({
                content: '❌ You are not a player in this game.',
                ephemeral: true
            });
        }

        // Format the hand for display
        const handDisplay = player.hand.length > 0
            ? player.hand.map(card => `• ${card}`).join('\n')
            : 'Your hand is currently empty.';

        await interaction.reply({
            content: `🃏 Here is your current hand:\n\n${handDisplay}`,
            ephemeral: true
        });
    }
}    
    // ----------------------------------------------------
    // 4. /spades status
    // ----------------------------------------------------
    if (subcommand === 'status') {
        
        // Handle Lobby State
        if (game.state === 'LOBBY') {
            const playerList = game.players.map(p => `\`${p.username}\``).join('\n');
            const lobbyEmbed = new EmbedBuilder()
                .setColor('#FF9900')
                .setTitle('Spades Lobby Status')
                .setDescription(`Waiting for **${4 - game.getLobbySize()}** more players to join.`)
                .addFields({ name: `Current Players (${game.getLobbySize()}/4)`, value: playerList || 'None yet.' });
                
            return interaction.reply({ embeds: [lobbyEmbed], ephemeral: false });
        }
        
        // Continue with Bidding/Playing Status
        const playerDetails = game.players.map((p, index) => {
            const team = (index === 0 || index === 2) ? 'Team 1' : 'Team 2';
            // Bid 0 means not bid yet, Bid 14 means Nil, otherwise show bid value
            const bidDisplay = p.bid === 0 ? '?' : p.bid === 14 ? 'Nil' : p.bid; 
            
            // Format: Player Name (Team) - Bid: X | Tricks: Y
            return `**${p.username}** (${team}) - Bid: \`${bidDisplay}\` | Tricks: \`${p.tricks}\``;
        }).join('\n');
        
        // Use the new helper function to display cards in the trick
        const cardsInTrickDisplay = game.trick.length > 0 
            ? game.trick.map(t => getCardEmojiDisplay(t.card)).join(' ') 
            : 'None';
            
        const currentTurnText = game.state === 'BIDDING'
            ? `Bidding: **${game.players[game.currentPlayerIndex].username}**`
            : game.state === 'PLAYING'
                ? `Playing: **${game.players[game.currentPlayerIndex].username}**`
                : 'Game Over';


        const gameStatusEmbed = new EmbedBuilder()
            .setColor('#1080A0')
            .setTitle(`Spades Game Status (Round ${game.currentRound})`)
            .setDescription(`**Game State:** ${game.state}\n` +
                            `**Dealer:** ${game.players[game.dealerIndex].username}`)
            .addFields(
                // NEW FIELD: Individual Player Details
                { name: 'Player Bids & Tricks', value: playerDetails, inline: false },
                // Renamed existing field for clarity
                { name: 'Team Totals (Score & Bags)', value: game.getTeamScoreDisplay(), inline: false }, 
                { name: 'Current Turn', value: currentTurnText, inline: true },
                { name: 'Cards in Trick', value: cardsInTrickDisplay, inline: true }
            );
        
        return interaction.reply({ embeds: [gameStatusEmbed], ephemeral: false });
    }

    // ----------------------------------------------------
    // 5. /spades play (IMPLEMENTING SPADES RULES VALIDATION)
    // ----------------------------------------------------
if (subcommand === 'play') {
    const game = activeGames.get(interaction.channelId);

    if (!game || game.state !== 'PLAYING') {
        return interaction.reply({
            content: `❌ You can only play cards during the PLAYING phase. Current state is: ${game?.state ?? 'none'}`,
            ephemeral: true
        });
    }

    const player = game.players.find(p => p.discordId === interaction.user.id);
    if (!player) {
        return interaction.reply({
            content: '❌ You are not a player in this game.',
            ephemeral: true
        });
    }

    if (player.id !== game.players[game.currentPlayerIndex].id) {
        return interaction.reply({
            content: `🚫 It is not your turn. It is **${game.players[game.currentPlayerIndex].username}**'s turn.`,
            ephemeral: true
        });
    }

    const cardInput = interaction.options.getString('card');
    const cardToPlay = game.getCardFromInput(player, cardInput);

    if (cardToPlay.error) {
        return interaction.reply({
            content: `🚫 Invalid play: ${cardToPlay.error}`,
            ephemeral: true
        });
    }

    // --- SPADES PLAY VALIDATION RULES START ---
    const leadSuit = game.trick.length > 0 ? game.trick[0].card.suit : null;
    const playedSuit = cardToPlay.suit;
    const playerHandSuits = player.getHandSuits();

    let validationError = null;

    if (leadSuit) {
        if (playedSuit !== leadSuit && playerHandSuits.includes(leadSuit)) {
            validationError = `You must follow suit: The leading suit is ${SUIT_EMOJIS[leadSuit]}. You have cards of this suit in your hand.`;
        }
    } else {
        if (playedSuit === 'S' && !game.spadesBroken) {
            const nonSpadeSuits = playerHandSuits.filter(s => s !== 'S');
            if (nonSpadeSuits.length > 0) {
                validationError = `Spades has not been broken yet. You cannot lead with a Spade unless you only have Spades remaining in your hand.`;
            }
        }
    }

    if (validationError) {
        return interaction.reply({
            content: `🚫 Invalid play: ${validationError}`,
            ephemeral: true
        });
    }
    // --- SPADES PLAY VALIDATION RULES END ---

    // Ensure trick is initialized
    if (!Array.isArray(game.trick)) {
        game.trick = [];
    }

    // 1. Add card to trick and remove from hand
    game.trick.push({ player, card: cardToPlay });
    player.removeCard(cardToPlay);

    // 2. Confirm play to the player
    const cardDisplayWithEmoji = getCardEmojiDisplay(cardToPlay);
    await interaction.reply({
        content: `✅ You played **${cardDisplayWithEmoji}**.`,
        ephemeral: true
    });

    // 3. Break Spades if needed
    if (playedSuit === 'S' && !game.spadesBroken) {
        game.spadesBroken = true;
        await interaction.channel.send("🚨 **SPADES ARE BROKEN!** ♠️ Spades can now be led.");
    }

    // 4. Check if trick is complete
    if (game.trick.length === 4) {
        const { winningPlayer, winningCard } = game.determineTrickWinner();

        if (!winningPlayer) {
            console.error("Critical Error: determineTrickWinner() did not return a valid player.");
            await interaction.channel.send("❌ Error: Game could not determine the trick winner. Check the bot's console for details.");
            return;
        }

        winningPlayer.tricks++;
        const winningCardEmojiDisplay = getCardEmojiDisplay(winningCard);

        let trickSummary = `🔥 **TRICK WON!** 🔥\n`;
        trickSummary += `**${winningPlayer.username}** wins the trick with the **${winningCardEmojiDisplay}**!\n`;
        trickSummary += `**${winningPlayer.username}** now has ${winningPlayer.tricks} tricks.`;

        await interaction.channel.send(trickSummary);

        game.trick = []; // Reset trick
        game.currentPlayerIndex = game.players.findIndex(p => p.id === winningPlayer.id);

        const totalTricks = game.players.reduce((sum, p) => sum + p.tricks, 0);
        if (totalTricks === 13) {
            const { roundSummary, isGameOver } = game.calculateRoundScores();

            const finalRoundMessage = new EmbedBuilder()
                .setColor('#4CAF50')
                .setTitle(`🏆 Round ${game.currentRound} Ended! 🏆`)
                .setDescription(roundSummary)
                .addFields(
                    { name: '\u200B', value: '\u200B', inline: false },
                    {
                        name: '📈 Overall Scores & Bags',
                        value: game.getTeamScoreDisplay(),
                        inline: false
                    }
                );

            await interaction.channel.send({
                content: `--- **ROUND ${game.currentRound} ENDED** ---`,
                embeds: [finalRoundMessage]
            });

            if (isGameOver) {
                const winnerMessage = game.endGame();
                await interaction.channel.send(`🎉 **GAME OVER!** 🎉\n**Winner:** ${winnerMessage}`);
                activeGames.delete(interaction.channelId);
            } else {
                game.currentRound++;
                game.dealerIndex = (game.dealerIndex + 1) % game.players.length;
                game.startRound();

                const nextDealer = game.players[game.dealerIndex].username;
                const firstBidder = game.players[game.currentPlayerIndex].username;

                await interaction.channel.send(`--- **STARTING ROUND ${game.currentRound}** ---\n` +
                    `New Dealer: **${nextDealer}**.\n` +
                    `It is **${firstBidder}**'s turn to bid first! Check DMs and use the buttons sent to you.`);

                await sendHandsAndBiddingButtons(game, interaction.channel, interaction.channelId);
            }

            return;
        }
    } else {
        // Trick continues: advance to next player
        game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
    }

    // 5. Announce next player
    if (game.state === 'PLAYING') {
        const nextPlayer = game.players[game.currentPlayerIndex].username;
        await interaction.channel.send(`It is now **${nextPlayer}**'s turn. Use \`/spades play <card>\`.`);
    }

    return;
}


// ✅ closes: if (subcommand === 'play')

 // ✅ closes: if (interaction.isChatInputCommand())
}); // ✅ closes client.on('interactionCreate', ...)

// --- Start Bot ---
client.login(TOKEN);

