# Digital E-Library

Child-friendly digital library (vanilla HTML/CSS/JS PWA). Learners sign in with a **4-digit code** issued by the administrator; there are no other accounts.

- **Books:** curated Project Gutenberg classics (full text, read-aloud, tap-a-word meanings, paged reader), Gutenberg search via Gutendex, and an Open Library discovery shelf. Starter stories and the Play Zone are built in.
- **Access codes:** administrator tab (passcode) creates, revokes, restores and deletes codes and shows usage and flagged AI questions. Each code is created as **Kids** or **Adult** (older codes default to Kids); the code a person signs in with decides which library they get.
- **Kids library:** colourful UI, starter stories, curated children's shelves, Play Zone, quizzes, badges, child-safe Kofi Reading Buddy with flagging.
- **Adult library:** calmer theme, classic literature / mystery / philosophy / science shelves plus SHS study shelves (Science, Mathematics, Geography & Agriculture, English Literature, Economics & Government) built from public-domain Gutenberg texts, unfiltered Gutenberg and Open Library search, "My Shelf", and an adult AI Library Assistant (no kids games, timer or flagging). Official free GES/MoE SHS Year 1 (by subject and section), Year 2 and Year 3 learner textbooks are readable in-app (pdf.js reader; pages stream on demand through an adult-only, path-restricted API proxy `lib/pdf` from curriculumresources.edu.gh, nothing is stored); commercial books such as Aki-Ola are copyrighted and not included. Shelf selection and the AI persona are enforced server-side from the session token (`t` claim).
- **Progress** (read list, favourites, badges, stars) is stored per code in the browser; usage counts sync to the server.

## Architecture

Browser -> Azure Function app `funcflex-elibrary-47854` (Flex Consumption, managed identity), resource group `rg-elibrary-demo` (eastus2):

- `api/lib/{login,admin,track,catalog,discover,text}` – code login (HMAC-signed 12 h session token), admin code management, and a proxy for Gutenberg/Gutendex/Open Library (Gutenberg sends no CORS headers). Codes and alerts live in Azure Table Storage (`stelib773289`, tables `codes` and `alerts`) via managed identity.
- `api/buddy` – AI Buddy -> Azure OpenAI (`gpt-4.1-mini`, content filter + child-safe prompt). Requires a valid session; flagged questions are saved for the administrator.

Required app settings: `ALLOWED_ORIGINS`, `AOAI_ENDPOINT`, `AOAI_DEPLOYMENT`, `TABLE_ENDPOINT`, `TOKEN_SECRET`, `ADMIN_PASS`. The function identity needs *Storage Table Data Contributor* on the storage account.

Deploy the API (zip with forward-slash paths): `az functionapp deployment source config-zip -g rg-elibrary-demo -n funcflex-elibrary-47854 --src api.zip`.
