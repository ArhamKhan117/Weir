/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      transitionDuration: {
        400: "400ms",
      },
    },
  },
  plugins: [],
};
