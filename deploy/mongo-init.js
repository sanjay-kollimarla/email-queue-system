// Runs inside the mongo1 network namespace (so MongoDB's localhost exception applies):
//  1. initiate the 3-member replica set the first time
//  2. create the root user the applications authenticate with
// Idempotent: safe to run on every `docker compose up`.
const members = [
  { _id: 0, host: "mongo1:27017", priority: 2 },
  { _id: 1, host: "mongo2:27017", priority: 1 },
  { _id: 2, host: "mongo3:27017", priority: 1 },
];

try {
  rs.status();
  print("replica set already initiated");
} catch (e) {
  if (/requires authentication|Unauthorized/i.test(String(e))) {
    print("auth already enabled: replica set and user exist");
    quit(0);
  }
  print("initiating replica set");
  rs.initiate({ _id: "rs0", members });
}

while (!db.hello().isWritablePrimary) sleep(500);

try {
  db.getSiblingDB("admin").createUser({
    user: process.env.MONGO_USER,
    pwd: process.env.MONGO_PASSWORD,
    roles: [{ role: "root", db: "admin" }],
  });
  print("created application user");
} catch (e) {
  if (!/already exists/i.test(String(e))) throw e;
  print("application user already exists");
}
