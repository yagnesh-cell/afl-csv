const fs = require("fs");
require("dotenv").config();
const fcl = require("@onflow/fcl");
const { SHA3 } = require("sha3");
var EC = require("elliptic").ec;
const ec = new EC("p256");
const fetch = require("node-fetch");

const packId = process.argv[3];

let packMetadata;
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

async function initialize() {
  fcl.config({
    "accessNode.api": process.env.ACCESS_NODE,
    "0xAFLAdmin": process.env.AFL_ADMIN_CONTRACT,
  });
  await getPackMetadata(packId, process.env.AFL_ADMIN_CONTRACT);
}

const getPackMetadata = async (templateId, contractAddress) => {
  packMetadata = await fcl.query({
    cadence: `
      import AFLNFT from ${contractAddress}
      pub fun main(templateId:UInt64): AFLNFT.Template {
        return AFLNFT.getTemplateById(templateId:templateId)
      }
    `,
    args: (arg, t) => [arg(templateId, t.UInt64)],
  });
};

const sendTxId = async (txId, combinationId) => {
  const raw = await fetch(`${process.env.BACKEND_URL}/api/tx/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      combinationId: combinationId,
      txId: txId,
    }),
  });
  const response = await raw.json();
  if (raw.status === 422) {
    throw new Error(response.result);
  }
  return response;
};

const getCombination = async () => {
  const raw = await fetch(
    `${process.env.BACKEND_URL}/api/mint-numbers/${packId}/get-combination`
  );
  const response = await raw.json();

  if (raw.status === 422) {
    throw new Error(response.result);
  }
  return response;
};

async function sendPack(address, key) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const { result, combinationId } = await getCombination();
    const castedIds = result.map((id) => {
      if (!id?.serial) {
        return [
          {
            key: "id",
            value: id.id,
          },
        ];
      } else {
        return [
          {
            key: "id",
            value: id.id,
          },
          {
            key: "serial",
            value: String(id.serial),
          },
        ];
      }
    });

    const serverAuthorizationProposerWithId = async (account) => {
      return await serverAuthorizationProposer(account, key);
    };

    let res = await fcl.send([
      fcl.transaction`
      import AFLAdmin from 0xAFLAdmin
      import AFLPack from 0xAFLAdmin
      transaction(templateIds: [{String: UInt64}], packTemplateId: UInt64, price:UFix64, receiptAddress: Address) {
        let adminRef: &AFLPack.Pack
        prepare(adminAccount: AuthAccount){
            self.adminRef = adminAccount.borrow<&AFLPack.Pack>(from: AFLPack.PackStoragePath)
                ??panic("could not borrow admin reference")
        }
        execute{
          self.adminRef.buyPackFromAdmin(templateIds: templateIds, packTemplateId: packTemplateId, receiptAddress: receiptAddress, price: price)
        }
      }
      `,
      fcl.args([
        fcl.arg(
          castedIds,
          fcl.t.Array(
            fcl.t.Dictionary({ key: fcl.t.String, value: fcl.t.UInt64 })
          )
        ),
        fcl.arg(String(packId), fcl.t.UInt64),
        fcl.arg(
          String(Number(packMetadata.immutableData?.price).toFixed(2)),
          fcl.t.UFix64
        ),
        fcl.arg(address[0], fcl.t.Address),
      ]),
      fcl.payer(serverAuthorization),
      fcl.proposer(serverAuthorizationProposerWithId),
      fcl.authorizations([serverAuthorization]),
      fcl.limit(1000),
    ]);
    console.log(
      `Airdropping pack to ${address[0]} using key ${key}. TX: ${res.transactionId}, Combination: ${combinationId}`
    );
    await fcl.tx(res).onceSealed();
    await sendTxId(res.transactionId, combinationId);
    return true;
  } catch (error) {
    console.log(`Failed to deploy to this address: ${address[0]}`);
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
  await initialize();
  const addresses = readFile();
  const promises = [];
  let keyIndex = 1;
  for (const address of addresses) {
    const addressDetails = address.split("\t");
    for (let i = 0; i < addressDetails[1]; i++) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      promises.push(sendPack(addressDetails, keyIndex));
      if (keyIndex === 490) {
        keyIndex = 1;
      } else {
        keyIndex++;
      }
    }
  }
  Promise.all(promises).then((values) => {
    console.log("Finished");
    console.log(failedIds);
  });
}

start();
