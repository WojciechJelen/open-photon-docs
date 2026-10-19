// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Comfy Challenge',
      description:
        'Working documentation for the Open Source Higgsfield entry: features, implementation steps, verification.',
      customCss: ['./src/styles/global.css'],
      sidebar: [
        {
          label: 'Getting started',
          items: [{ autogenerate: { directory: 'getting-started' } }],
        },
        {
          label: 'Features',
          items: [
            {
              label: 'Genjutsu',
              items: [
                { label: 'Overview', slug: 'features/genjutsu' },
                {
                  label: 'Implementation steps',
                  slug: 'features/genjutsu/implementation-steps',
                },
              ],
            },
          ],
        },
      ],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
