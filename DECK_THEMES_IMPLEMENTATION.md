# Custom Deck Themes Implementation Guide

## ✅ Completed So Far

### 1. User Preferences System
- ✅ Added `deckTheme: 'classic'` to DEFAULT_PREFERENCES in `userPreferences.js`
- ✅ Options: 'classic', 'steampunk', 'minimalist', 'neon', 'medieval'

### 2. CardRenderer.js - Theme System
- ✅ Added DECK_THEMES object with 5 complete themes:
  - **Classic**: Traditional white cards with gradients
  - **Steampunk**: Brass/copper tones with gears, rivets, and patina
  - **Minimalist**: Pure white, clean design, no decorations
  - **Neon**: Dark background with glowing cyan/pink/lime suits
  - **Medieval**: Parchment-style with ornate flourishes

- ✅ Created helper functions:
  - `drawSteampunkTexture()` - Adds brass rivets, gears, and aged patina
  - `applyNeonGlow()` - Applies glowing effects to suit symbols
  - `drawMedievalOrnaments()` - Adds decorative corner flourishes and parchment texture

- ✅ Updated `renderCard()` function:
  - Added `deckTheme` parameter (default: 'classic')
  - Applies themed backgrounds, borders, fonts
  - Handles neon suit colors (cyan, hot pink, lime, yellow)
  - Applies theme-specific decorations
  - Conditionally applies shadows based on theme
  - Uses themed fonts for face cards

## 🔄 Still Need to Complete

### 3. Update Helper Functions
- ⏳ Update `drawCardOnCanvas()` to accept and use deckTheme
- ⏳ Update `drawTrickCardOnCanvas()` to accept and use deckTheme

### 4. Update Public Function Signatures
- ⏳ Update `renderHand()` to accept deckTheme parameter
- ⏳ Update `renderSingleCard()` to accept deckTheme parameter  
- ⏳ Update `renderTrickCards()` to accept deckTheme parameter

### 5. UI Implementation in index.js
- ⏳ Add deck theme selector to `/spades preferences` command
- ⏳ Create `deck_theme_select` interaction handler
- ⏳ Sync deck theme changes to active game players

### 6. Update All Render Calls
- ⏳ Find all `renderHand()` calls and pass `player.preferences.deckTheme`
- ⏳ Find all `renderCard()` calls and pass `player.preferences.deckTheme`
- ⏳ Find all `renderTrickCards()` calls and pass appropriate deckTheme

## Theme Previews

### 🎴 Classic (Default)
- White cards with subtle gray gradient
- Navy borders
- Standard fonts (Arial, Georgia for face cards)
- Professional appearance

### ⚙️ Steampunk
- Brass/copper gradient background (#D4A574 → #8B6F47)
- Dark brown borders (#4A3728)
- Brass rivets in all four corners
- Decorative gear pattern in bottom-right
- Aged patina spots for vintage look
- Times New Roman font

### ⬜ Minimalist
- Pure white background
- Black border only, no inner border
- No shadows, no decorations
- Clean Helvetica font
- Perfect for those who want simplicity

### 💡 Neon
- Dark background (#0a0a0a → #1a1a1a)
- Cyan and magenta borders
- Glowing suit symbols:
  - Spades: Cyan (#00ffff)
  - Hearts: Hot pink (#ff0080)
  - Diamonds: Lime (#00ff00)
  - Clubs: Yellow (#ffff00)
- Cyberpunk aesthetic

### 🏰 Medieval
- Parchment background (#F5E6D3 → #E8D5B7)
- Brown borders (#5C4033)
- Ornate corner flourishes
- Subtle parchment texture lines
- Palatino Linotype font for classical feel

## Testing Checklist

Once implementation is complete:
- [ ] `/spades preferences` shows deck theme selector
- [ ] Changing deck theme updates user preferences
- [ ] Hand images reflect selected theme
- [ ] Trick cards reflect player's theme
- [ ] All 5 themes render correctly
- [ ] Theme persists across game sessions
- [ ] No console errors

## Usage Examples

```javascript
// After implementation, usage will be:
const handBuffer = renderHand(
    player.hand, 
    player.preferences.colorBlindMode,
    player.preferences.deckTheme  // 'steampunk', 'neon', etc.
);

const cardBuffer = renderCard(
    'K', 'S', 
    false, 
    'medieval'  // Medieval theme
);
```

## Notes

- Card backs (cardBackTheme) and card faces (deckTheme) are independent
- Players can mix any card back color with any deck theme
- Themes are personal - each player sees their own preferred style
- Spectators see card backs using the host's cardBackTheme preference
