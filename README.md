# Telegram Web App

This is a Svelte 5 web application designed to interact with the [Telegram Bot](../bot). It is built with SvelteKit and optimized for deployment on Cloudflare Pages.

## Features

- **Svelte 5**: Built using the latest Svelte features and patterns.
- **Telegram Auth**: Secure authentication using Telegram's Web App / Login Widget data.
- **AI Chat Interface**: A clean UI for interacting with the AI bot.
- **Cloudflare Pages**: High-performance hosting with SSR (Server-Side Rendering) on the edge.
- **Markdown Support**: Rich message rendering with Markdown support.

## Development

1. **Install dependencies**:
   ```sh
   npm install
   ```

2. **Start the development server**:
   ```sh
   npm run dev
   ```

3. **Configure bindings**:
   Update `wrangler.toml` with the necessary KV and AI bindings to match your production environment.

## Deployment

To build and deploy the application to Cloudflare Pages:

```sh
npm run build
npx wrangler pages deploy .svelte-kit/cloudflare
```

## License

Apache-2.0
