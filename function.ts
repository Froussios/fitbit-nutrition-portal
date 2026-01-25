import * as functions from '@google-cloud/functions-framework';
import express from 'express';
import * as npm from "./package.json";
import path from 'path';

console.info(npm.config.function_name, npm.version);

const app = express();

app.get(['/data'], async (req, res) => {
  res.json({
    data: "value"
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'Server is running',
    version: npm.version
  });
});

app.use(['/static', '/', ''], express.static(path.join(__dirname, 'static/')));

if (process.argv.includes('--local')) {
  const port = 8080;
  app.listen(port, () => {
    console.log(`Server is running locally on http://localhost:${port}`);
  });
} else {
  // Export the app as a Google Cloud Function
  functions.http(npm.config.function_name, app);
}
