import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs: works at user.github.io/<repo>/, on a custom domain, and on Firebase Hosting.
  base: './',
  // Flat layout: there is no /public folder. PWA assets are added in Phase 18.
  publicDir: false,
  build: {
    target: 'es2021',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) return 'firebase';
          if (id.includes('node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
  test: { environment: 'node', include: ['*.test.ts', '*.test.tsx'] },
});
