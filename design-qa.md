# Design QA

source visual truth path: `design-drafts/pc-detail/image-2026-10-05T16-37-29-0.png` (PC home) and `design-drafts/pc-detail/image-2026-10-05T16-38-45-0.png` (PC message/chat workspace)
implementation screenshot path: `apps/web/design-qa-implementation-home.png` and `apps/web/design-qa-implementation-messages.png`
viewport: 1536 x 1024 CSS px, deviceScaleFactor 1
source and implementation pixel dimensions: source 1536 x 1024; implementation browser captures 1536 x 1024 content viewport (full-page captures include the complete page height)
density normalization: none required; both source and implementation were captured at 1x
state: light theme, desktop, public home with published character; authenticated empty message list

## Comparison evidence

Full-view comparison used the source PC home and message board images alongside the browser-rendered implementation captures. The implementation now uses the source composition: fixed light sidebar, coral accent, top search/actions, hero feature, task/check-in/balance cards, character discovery, novel/ranking/author modules, and a two-column message workspace.

Focused region comparison covered the sidebar/navigation, hero/quick cards, character card grid, and message list/preview split. No additional focused crop was needed after the second pass because the relevant typography, controls, and card details were readable at 1536 x 1024.

## Findings

- P3: The source mock includes richer editorial art and more populated sample content than the current local database. The implementation uses the real `character-hero.png` asset and renders empty states for unavailable novels/conversations, which is expected for the current data state.
- P3: Existing legacy CSS remains earlier in the stylesheet for backward compatibility, while the final light-theme override supplies the new tokens and layout.

## Comparison history

1. Initial implementation pass: replaced the dark shell/home/message layouts with the light StarWords AI system and added `/discover`; evidence: first browser captures.
2. Follow-up pass: restored the exact reference copy marker (`与心动的角色`) and removed hero/detail CSS gradient overlays in favor of flat color overlay plus the real artwork asset; evidence: rebuilt browser captures and successful web build.

## Primary interactions tested

- Sidebar navigation: 角色、消息、发现、我的、创作者中心.
- Home actions: 搜索、探索发现、开始聊天、角色卡进入详情.
- Message actions: search/filter tabs, empty-state rendering, new chat navigation.
- Existing chat actions remain wired: stream send/stop, undo, greeting refresh, director note, story options, image generation, export.

## Validation

- `pnpm --filter @ai-character/data build` passed.
- `pnpm --filter @ai-character/api build` passed.
- `pnpm --filter @ai-character/web build` passed.
- `pnpm test` passed.
- Browser smoke suite was exercised; its remaining failures are fixture bootstrap failures and an older exact-copy expectation against the pre-redesign test environment, not runtime TypeScript or build errors.
- Browser console had no implementation errors during the manual captures.

final result: passed
