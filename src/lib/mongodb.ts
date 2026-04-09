import { MongoClient, Db } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI as string;
const DB_NAME = "ux_audit";

if (!MONGODB_URI) {
  throw new Error("Please define MONGODB_URI in .env.local");
}

// In development, cache the client on the global object so hot-reloading
// doesn't spawn a new connection on every module re-evaluation.
declare global {
  // eslint-disable-next-line no-var
  var _mongoClient: MongoClient | undefined;
}

let client: MongoClient;

if (process.env.NODE_ENV === "development") {
  if (!global._mongoClient) {
    global._mongoClient = new MongoClient(MONGODB_URI);
  }
  client = global._mongoClient;
} else {
  client = new MongoClient(MONGODB_URI);
}

export async function getDb(): Promise<Db> {
  await client.connect();
  return client.db(DB_NAME);
}
