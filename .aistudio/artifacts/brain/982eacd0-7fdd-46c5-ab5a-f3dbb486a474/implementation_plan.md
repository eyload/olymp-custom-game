# OLYMP CUSTOM: Crimson Gaming Redesign, Hero Card Showcase & Gemini AI

A complete visual and architectural overhaul of OLYMP CUSTOM inspired by the mobile gaming UI reference image. The redesign introduces a crimson-burgundy glassmorphic aesthetic, an interactive Favorite Hero catalog with character skill cards, migration of OLYMP AI from Claude to Google Gemini 2.5 Pro, and a stylized match summary export for Telegram channels.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural and UX decisions were confirmed and guide the implementation:

- **Visual Theme (Confirmed)**: Crimson-burgundy dark gaming aesthetic (`#0c0608` deep obsidian base, `#7f1d24` to `#ff2d46` crimson gradients, ember glow backlights, frosted glass containers with subtle specular borders, and high-impact typography).
- **Gemini Model Choice (Confirmed)**: Google Gemini 2.5 Pro (`gemini-2.5-pro`) for in-depth tactical reasoning across draft recommendations, hero analysis, and player coaching.
- **Favorite Hero Display (Confirmed)**: The selected favorite hero is spotlighted across the Home screen, Player Profile, and rendered onto shared canvas story cards.
- **Hero Catalog & Selection (Confirmed)**: Role filter tabs (Jungle, EXP, Mid, Gold, Roam), real-time name search, tier filter (S, A, B, C, D), and a hero detail preview sheet showcasing character artwork, lane roles, skills, and combat stats.
- **Match Summary Export (Confirmed)**: Telegram-formatted text block with emojis, bold team titles, full player rosters with roles and MVP badge, with one-tap clipboard copy in match modals and post-match lobby banners.

---

## 1. Overview & Core Concept

OLYMP CUSTOM transitions from a standard Telegram WebApp layout into an esports-grade mobile experience matching the reference design:
1. **Favorite Hero Showcase**: Players can explore all heroes in the meta, examine their stats and skills, and set a "Favorite Hero" that personalizes their profile, lobby presence, and story cards.
2. **Gemini 2.5 Pro Engine**: Replaces `@anthropic-ai/sdk` with `@google/genai`, providing deeper strategic drafting advice, tactical hero counters, and coach analysis tailored to MLBB.
3. **Stylized Match Telegram Export**: Organizers and players can copy clean, emoji-formatted match rosters for Telegram channel posts with one tap.
4. **Cinematic Gaming Interface**: Deep burgundy backgrounds with glowing crimson ambient halos, floating frosted dock navigation, and interactive hero cards.

---

## 2. User Experience & Visual Design

### Screen Layouts & Component Design

#### A. Home Screen Redesign
- **Hero Banner ("Выбери любимого героя")**: Top card inspired by the reference image displaying the player's selected Favorite Hero with dynamic artwork, role badge, and quick stats, or an invitation to choose one.
- **Quick Hero Grid**: 2x2 grid of popular meta heroes (with portrait art, name, and tier) leading directly into the Hero Detail sheet.
- **Status & Navigation**: Segmented status summary (Lobby counter, current season days remaining, rating RP) styled with translucent frosted-glass panels (`backdrop-blur-xl bg-neutral-950/70 border border-red-500/15`).
- **Floating Bottom Dock**: Rounded translucent pill dock anchored above the safe-area inset with illuminated active icons for Home, Lobby, Heroes, Rating, and AI.

#### B. Hero Selection Catalog & Card Detail Sheet
- **Search & Filter Bar**: Pill search input (`Search your hero...`) with live search matching Russian and English names.
- **Role Segmented Tabs**: All, Jungle (🌲), EXP (🛡️), Mid (⚡), Gold (🏹), Roam (🤝).
- **Hero Grid Cards**: High-res hero portrait, Russian and English names, win rate, pick rate, and S/A/B tier badges.
- **Hero Detail Modal (Matching Reference Screen)**:
  - Big character portrait bursting with crimson rim lighting.
  - Role pills (e.g. `Jungle, Assassin`).
  - Hero Title in heavy bold display font.
  - Combat skill icons with glowing borders and tooltips.
  - Stat bars (Early Power, Late Power, Winrate, Difficulty) with illuminated crimson gradient sliders.
  - Action CTA: **"Выбрать любимым героем"** (saves to player profile in DB and local state).

#### C. Match Summary Telegram Export
- Added to `matchSheet` and `repBox` as **"📋 Скопировать сводку"**.
- Formats winner, MVP, and 5v5 rosters with lane emojis into clipboard-ready Telegram text with haptic confirmation.

---

## 3. Key Product Decisions & Trade-Offs

- **Hero Artwork Assets**:
  - *Approach*: Leverage official Moonton / mobilelegends.com CDN head and splash portraits already mapped in `meta-data.js` and `SNAPSHOT_HEROES`, augmented with high-resolution hero assets and resilient fallback avatars so every hero displays clean art.
- **Gemini SDK Migration**:
  - *Approach*: Install `@google/genai`, initialize server-side via `new GoogleGenAI({ apiKey })`, route `/api/ai/ask` requests to `ai.models.generateContent` with `gemini-2.5-pro` (and configurable model fallback).
  - *Why*: Eliminates Anthropic dependency, provides superior reasoning on complex drafts, and uses official AI Studio Gemini patterns.
- **Favorite Hero Persistence**:
  - *Approach*: Store `favorite_hero` in the `users` table (and in-memory mock store) alongside user profile updates.

---

## 4. Technical Architecture & Data Strategy

### System Component Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                        OLYMP CUSTOM Client (Web)                       │
│                                                                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │    Home View     │  │   Hero Catalog   │  │  Match Results Sheet │  │
│  │ (Favorite Hero & │  │  (Role Filters,  │  │  (Rosters + Copy TG  │  │
│  │  Lobby Counter)  │  │   Detail Card)   │  │     Summary CTA)     │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────┬───────────┘  │
│           │                     │                       │              │
│           ▼                     ▼                       ▼              │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │          Crimson-Burgundy Glassmorphism Design System            │  │
│  │    (--bg: #090507, --card: #140a0e, --crimson: #ff2d46, etc.)    │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
└─────────────────────────────────────┼──────────────────────────────────┘
                                      │ REST API (/api/*)
                                      ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      Express Server (server.js)                        │
│                                                                        │
│  ┌─────────────────────────┐           ┌────────────────────────────┐  │
│  │  Database & Store Layer │           │       OLYMP AI Engine      │  │
│  │ (Postgres / Mock Store) │           │    (@google/genai SDK)     │  │
│  │  • users (favorite_hero)│           │    • Model: gemini-2.5-pro │  │
│  │  • lobbies, matches     │           │    • Draft, Chat, Coach    │  │
│  └─────────────────────────┘           └────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

### Execution Steps
1. **Dependencies**: Install `@google/genai` via `install_applet_package` and remove legacy Claude imports.
2. **Server Gemini Integration**: Replace `aiRun` Anthropic client calls with `@google/genai` `ai.models.generateContent({ model: 'gemini-2.5-pro', ... })`. Update `users` schema to persist `favorite_hero`.
3. **Design System & Theme Overhaul**: Update CSS variables, background radial lighting, frosted cards, and dock styles in `public/index.html` to crimson-burgundy obsidian palette.
4. **Favorite Hero Menu & Cards**: Implement the hero catalog, filter tabs, hero detail modal with stats and skills, and selection handler.
5. **Match Summary Export**: Add formatted Telegram text generator and clipboard copy buttons to match sheets and lobby.
6. **Verification**: Run `lint_applet` and `compile_applet`, then restart dev server.
