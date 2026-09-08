// Password protection can be turned on here, or without editing this file by
// starting the server with `config=true npm start` (or CHALLENGE=true).
const envChallenge = process.env.CHALLENGE ?? process.env.config;

const config = {
  challenge: envChallenge !== undefined ? envChallenge === "true" : false, // Set to true if you want to enable password protection.
  users: {
    // You can add multiple users by doing username: 'password'.
    interstellar: process.env.PASSWORD || "password",
  },
};

export default config;
