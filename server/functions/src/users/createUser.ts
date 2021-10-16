import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

export const createUser = functions.auth.user().onCreate(async (user) => {
  await admin.firestore().collection("users").doc(user.uid).set({
    name: user.displayName,
    avatar: user.photoURL,
  });
});

