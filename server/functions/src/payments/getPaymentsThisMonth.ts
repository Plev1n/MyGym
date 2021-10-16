import * as functions from 'firebase-functions'
import {firestore} from 'firebase-admin'
import {DateTime} from "luxon";

interface IncomesPerMonth {
    month: number
    amount: number
    count: number
    expected: number
}

export const getPaymentsThisMonth = functions.https.onCall(async (data, context) => {
    const userId = context.auth?.uid!!
    const incomes = await firestore().collection('incomes').where('user_id', '==', userId).get()
    const clients = await firestore().collection('clients').where('user_id', '==', userId).get()
    const amount = incomes.docs.reduce((partial_sum, a) => partial_sum + a.get('amount'), 0)
    return {
        expected: clients.size,
        count: incomes.size,
        month: DateTime.now().month,
        amount
    } as IncomesPerMonth
})