import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';
import { visualizer } from 'rollup-plugin-visualizer';
export default defineConfig({
    plugins: [
        react(),
        dts({
            insertTypesEntry: true,
        }),
        visualizer({
            filename: 'dist/stats.html',
            open: true,
            gzipSize: true,
            brotliSize: true,
        }),
    ],
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
                    manualChunks: {
                        recorder: ['extendable-media-recorder', 'extendable-media-recorder-wav-encoder'],
                        detect: ['react-device-detect'],
                        onnxruntime: ['onnxruntime-web'],
                    },
                },
        },
    },
});