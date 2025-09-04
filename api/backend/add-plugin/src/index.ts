import express from 'express'

const app = express()
const port = process.env.EXPRESS_PORT || 3000

app.get('/', (req, res) => {
  console.log(req)
  res.send('Hello from the Node.js Microservice!');
});

app.listen(port, () => {
  console.log(`Microservice listening on port ${port}`);
});
