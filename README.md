# Digital E-Library – Client Demo

Clickable prototype for the child-friendly Digital E-Library proposal (v2.2). Vanilla HTML/CSS/JS, no backend; AI replies and staff data are simulated.

This repository is the starting point for the production app.

Demo PINs: any 4 digits (child), `0000` (staff).

## AI architecture

Browser -> Azure Function (`api/buddy`, Flex Consumption, managed identity) -> Azure OpenAI (`gpt-4.1-mini`, built-in content filter + child-safe system prompt). No keys in the repo or browser; the function restricts CORS to the Pages origin and rate-limits. Resources live in resource group `rg-elibrary-demo` (eastus2).
