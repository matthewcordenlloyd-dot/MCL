# Security

## Keys and secrets

No API keys, passwords or tokens are stored in this repository.

- Optional keys go in a `.env.local` file next to the project. The root `.gitignore` blocks every `.env` file, so they can't be committed by accident.
- If a key is ever committed by mistake, **revoke it on the provider's website straight away**. Deleting the file afterwards doesn't help, because it stays in the git history.

## Reporting a problem

If you find a security issue in anything here, please open an issue on GitHub without including any exploit details, and I'll get in touch.
