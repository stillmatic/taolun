import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';
import {viteStaticCopy} from 'vite-plugin-static-copy';

export default defineConfig({
    plugins: [
        react(),
        dts({
            insertTypesEntry: true,
        }),
        viteStaticCopy({
            targets: [
                {
                    src: 'node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js',
                    dest: './'
                },
                {
                    src: 'node_modules/@ricky0123/vad-web/dist/silero_vad.onnx',
                    dest: './'
                },
                {
                    src: 'node_modules/onnxruntime-web/dist/*.wasm',
                    dest: './'
                }
            ]
        })],
    build: {
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            name: 'taolun',
            formats: ['es'],
            fileName: (format) => `taolun.${format}.js`,
        },
        rollupOptions: {
            external: ['react', 'react-dom', 'Buffer'],
            output: {
                globals: {
                    react: 'React',
                    'react-dom': 'ReactDOM',
                },
            },
        },
    },
});