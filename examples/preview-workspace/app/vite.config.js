export default {
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: [process.env.PREVIEW_HOST],
  },
};
