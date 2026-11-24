# Contributing to TestPilot Test Manager

Thanks for helping improve TestPilot Test Manager.

TestPilot Test Manager is exclusively developed and maintained by QAble Testlab.

## Development

TestPilot Test Manager is a monorepo with three main services:

- `Testpilot-Frontend/` - Next.js frontend
- `Testpilot-Backend/` - Java 17 backend

Before opening a pull request, please run the relevant checks for the area you changed:

```bash
cd Testpilot-Frontend
npm install
npm run lint
npm run build
```

```bash
cd Testpilot-Backend
mvn test
```

## Pull Requests

- Keep changes focused and explain the user-visible behavior.
- Include tests or validation notes for behavior changes.
- Do not commit secrets, local `.env` files, logs, uploads, screenshots, database dumps, or build output.
- By submitting a contribution, you agree that it is licensed under the Apache License 2.0.

## License

TestPilot Test Manager is licensed under the Apache License 2.0. See `LICENSE`.
