const fs = require("fs");
require("dotenv").config();
const fcl = require("@onflow/fcl");
const { SHA3 } = require("sha3");
var EC = require("elliptic").ec;
const ec = new EC("p256");

const failedIds = [];

function hash(message) {
  const sha = new SHA3(256);
  sha.update(Buffer.from(message, "hex"));
  return sha.digest();
}

async function getSignature(signable) {
  const message = signable.message;
  const key = ec.keyFromPrivate(Buffer.from(process.env.PRIVATE_KEY, "hex"));
  const sig = key.sign(hash(message)); // hashMsgHex -> hash
  const n = 32;
  const r = sig.r.toArrayLike(Buffer, "be", n);
  const s = sig.s.toArrayLike(Buffer, "be", n);
  return Buffer.concat([r, s]).toString("hex");
}

async function serverAuthorization(account) {
  const addr = `0x${process.env.ADMIN_ADDRESS}`;
  const keyId = 0;

  return {
    ...account,
    tempId: `${addr}-${keyId}`,
    addr: fcl.sansPrefix(addr),
    keyId: Number(keyId),
    signingFunction: async (signable) => {
      const signature = await getSignature(signable);
      return {
        addr: fcl.withPrefix(addr),
        keyId: Number(keyId),
        signature,
      };
    },
  };
}

const serverAuthorizationProposer = async (account, key) => {
  const addr = `0x${process.env.ADMIN_ADDRESS}`;
  const keyId = key;

  return {
    ...account,
    tempId: `${addr}-${keyId}`,
    addr: fcl.sansPrefix(addr),
    keyId: Number(keyId),
    signingFunction: async (signable) => {
      const signature = await getSignature(signable);
      return {
        addr: fcl.withPrefix(addr),
        keyId: Number(keyId),
        signature,
      };
    },
  };
};

function initialize() {
  fcl.config({
    "accessNode.api": process.env.ACCESS_NODE,
    "0xAFLAdmin": process.env.AFL_ADMIN_CONTRACT,
  });
}

async function sendNFT(address, key) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 750));

    const selectedMoment = process.argv[3];

    const serverAuthorizationProposerWithId = async (account) => {
      return await serverAuthorizationProposer(account, key);
    };

    let res = await fcl.send([
      fcl.transaction`
      import AFLAdmin from 0xAFLAdmin
      transaction() {
          prepare(acct: AuthAccount) {
              let adminRef = acct.borrow<&AFLAdmin.Admin>(from: /storage/AFLAdmin)
                  ??panic("could not borrow reference")
              let addr: Address = ${address}
              let moment = {"id": ${selectedMoment}} as {String: UInt64}
              adminRef.openPack( templateInfo: moment, account: addr)
          }
      }
      `,
      fcl.payer(serverAuthorization),
      fcl.proposer(serverAuthorizationProposerWithId),
      fcl.authorizations([serverAuthorization]),
      fcl.limit(1000),
    ]);
    console.log(
      `Airdropping ${selectedMoment} to ${address} using key ${key}. TX: ${res.transactionId}`
    );
    await fcl.tx(res).onceSealed();
    return true;
  } catch (error) {
    console.log(`Failed to deploy to this address: ${address}`);
    console.log(error);
    failedIds.push(address);
    return false;
  }
}

function readFile() {
  const fileName = process.argv[2];
  const rawData = fs.readFileSync(`./${fileName}`, "utf8").toString();
  return rawData.split("\n");
}

async function start() {
  initialize();
  const addresses = readFile();
  const promises = [];
  let keyIndex = 1;
  for (const address of addresses) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    promises.push(sendNFT(address, keyIndex));
    if (keyIndex === 490) {
      keyIndex = 1;
    } else {
      keyIndex++;
    }
  }
  Promise.all(promises).then((values) => {
    console.log("Finished");
    console.log(failedIds);
  });
}

start();
