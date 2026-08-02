Run the E2E suite with `npm run test:e2e`; install Chromium first with `npx playwright install chromium`.

These are behavior-fixing characterization tests. Do not modify their assertions during refactoring: a failed assertion means behavior changed and requires manual judgment to determine whether it is a regression or an intentional change.
