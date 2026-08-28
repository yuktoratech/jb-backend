require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();

  app.listen(PORT, (error) => {
    if (error) {
      console.error(`Server failed to start on port ${PORT}:`, error.message);
      process.exit(1);
      return;
    }

    console.log(
      `Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`,
    );
  });
};

startServer().catch((error) => {
  console.error('Server startup failed:', error.message);
  process.exit(1);
});
