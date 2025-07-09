/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,jsx,ts,tsx}",     // all page files
    "./components/**/*.{js,jsx,ts,tsx}",// any components folder you create
    "./app/**/*.{js,jsx,ts,tsx}",       // if you’re using the /app directory
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
