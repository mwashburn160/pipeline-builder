import express from 'express'

const app = express()
const port = 3000

app.get('/api/add-plugin', (req, res) => {
  console.log(req)
  res.send('Hello from the Node.js Microservice!');
});

app.listen(port, () => {
  console.log(`Microservice listening on port: ${port}`);
});
