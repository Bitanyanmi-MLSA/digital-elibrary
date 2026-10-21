# Digital E-Library

Child-friendly digital library (vanilla HTML/CSS/JS PWA). Learners sign in with a **4-digit code** issued by the administrator; there are no other accounts.

- **Books:** curated Project Gutenberg classics (full text, read-aloud, tap-a-word meanings, paged reader), Gutenberg search via Gutendex, and an Open Library discovery shelf. Starter stories and the Play Zone are built in.
- **Access codes:** administrator tab (passcode) creates, revokes, restores and deletes codes and shows usage and flagged AI questions.
- **Progress** (read list, favourites, badges, stars) is stored per code in the browser; usage counts sync to the server.

## Architecture

Browser -> Azure Function app `funcflex-elibrary-47854` (Flex Consumption, managed identity), resource group `rg-elibrary-demo` (eastus2):

- `api/lib/{login,admin,track,catalog,discover,text}` – code login (HMAC-signed 12 h session token), admin code management, and a proxy for Gutenberg/Gutendex/Open Library (Gutenberg sends no CORS headers). Codes and alerts live in Azure Table Storage (`stelib773289`, tables `codes` and `alerts`) via managed identity.
- `api/buddy` – AI Buddy -> Azure OpenAI (`gpt-4.1-mini`, content filter + child-safe prompt). Requires a valid session; flagged questions are saved for the administrator.

Required app settings: `ALLOWED_ORIGINS`, `AOAI_ENDPOINT`, `AOAI_DEPLOYMENT`, `TABLE_ENDPOINT`, `TOKEN_SECRET`, `ADMIN_PASS`. The function identity needs *Storage Table Data Contributor* on the storage account.

Deploy the API (zip with forward-slash paths): `az functionapp deployment source config-zip -g rg-elibrary-demo -n funcflex-elibrary-47854 --src api.zip`.
