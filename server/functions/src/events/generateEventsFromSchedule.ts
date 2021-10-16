import * as functions from 'firebase-functions'
import {firestore} from 'firebase-admin'
import {DateTime} from 'luxon'
import DocumentData = firestore.DocumentData;
import QueryDocumentSnapshot = firestore.QueryDocumentSnapshot;

interface EventId {
    type: 'group' | 'client'
    objectId: string
    date: DateTime
    duration: number
}

interface Event {
    id: string
    type: 'group' | 'client'
    cancelled: boolean
    from: string
    durationMinutes: number
    group_id?: string
    client_id?: string
}

function toEventId(date: DateTime, schedule: QueryDocumentSnapshot<DocumentData>): EventId {
    if (date.weekday == schedule.get('weekday')) {
        return {
            type: schedule.get('group_id') ? 'group' : 'client',
            objectId: schedule.get('group_id') ?? schedule.get('client_id'),
            date: date.set({hour: schedule.get('hour'), minute: schedule.get('minute'), second: 0}),
            duration: schedule.get('durationMinutes')
        }
    } else {
        throw Error("Date $date does not match the schedule ")
    }
}

function eventIdToString(classId: EventId): string {
    const formattedDate = classId.date.toFormat("yyyyMMddHHmm")
    const prefix = classId.type === 'group' ? `group_${classId.objectId}` : `client_${classId.objectId}`
    return `${prefix}_${formattedDate}_${classId.duration}`
}

function eventIdToEvent(classId: EventId): Event {
    return {
        id: eventIdToString(classId),
        type: classId.type,
        from: classId.date.toISO(),
        durationMinutes: classId.duration,
        cancelled: false,
        group_id: classId.type === 'group' ? classId.objectId : undefined,
        client_id: classId.type === 'client' ? classId.objectId : undefined,
    }
}

async function getSortedScheduleFrom(
    from: DateTime,
    userId: string
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
    const schedules = await firestore()
        .collection('schedules')
        .where('user_id', '==', userId)
        .orderBy('weekday')
        .orderBy('time')
        .get()
    const index = schedules.docs.findIndex(it => it.get('weekday') >= from.weekday)
    if (index >= 0) {
        const result: QueryDocumentSnapshot<DocumentData>[] = []
        result.push(...schedules.docs.slice(0, index))
        result.push(...schedules.docs.slice(index, schedules.docs.length))
        return result
    } else {
        return schedules.docs
    }
}

async function merge(existing: Event[], generated: Event[]): Promise<Event[]> {
    const existingClassesMap: {[field: string]: Event} = {}
    existing.forEach(it => existingClassesMap[it.id] = it)
    const generatedIds = generated.map(it => it.id)
    const result = []
    result.push(...generated.map(it => existingClassesMap[it.id] ?? it).filter(it => !it.cancelled))
    result.push(...existing.filter(it => !generatedIds.includes(it.id)).filter(it => !it.cancelled))
    result.sort((o1, o2) => DateTime.fromISO(o1.from).diff(DateTime.fromISO(o2.from)).days)
    return result;
}

async function getExistingClasses(
    from: DateTime,
    to: DateTime,
    cancelled?: boolean,
): Promise<Event[]> {
    const events = await firestore().collection('events')
        .where('from', '>', from.toJSDate())
        .where('from', '<', to.toJSDate())
        .where('cancelled', '==', cancelled)
        .get()
    return events.docs.map(it => ({
        id: it.id,
        type: it.get('group_id') ? 'group' : 'client',
        cancelled: it.get('cancelled'),
        from: it.get('from'),
        durationMinutes: it.get('durationMinutes'),
        group_id: it.get('group_id'),
        client_id: it.get('client_id'),
    }))
}

async function getMergedClassesBetweenDatesWithUpcomingGeneration(
    userId: string,
    startDate: DateTime,
    endDate: DateTime,
    sortedScheduleFrom: QueryDocumentSnapshot<DocumentData>[],
): Promise<Event[]> {
    const generatedClasses: Event[] = []
    if (sortedScheduleFrom.length > 0) {
        let generatingDate: DateTime;
        if (startDate < DateTime.now()) {
            generatingDate = DateTime.now()
        } else {
            generatingDate = startDate
        }
        const localTo = endDate.toLocal().plus({days: 1})
        //it can be slightly bigger, we will remove other items
        while (generatingDate < localTo) {
            const generatedClassesForDate = sortedScheduleFrom
                .filter(it => it.get('weekday') == generatingDate.weekday)
                .map(it => eventIdToEvent(toEventId(generatingDate, it)))
                .filter(it => DateTime.fromISO(it.from) > startDate)
            generatedClasses.push(...generatedClassesForDate)
            generatingDate = generatingDate.plus({days: 1})
        }
    }
    const existingClasses = await getExistingClasses(startDate, endDate)
    return merge(existingClasses, generatedClasses)
}

export let getEventsByDates = functions.https.onCall(async (data, context) => {
    const startDate = DateTime.fromISO(data.startDate)
    const endDate = DateTime.fromISO(data.endDate)
    const userId = context.auth?.uid
    const user = await firestore().doc(`users/${userId}`).get()
    if (!user.exists) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid user');
    }
    const sortedScheduleFrom = await getSortedScheduleFrom(startDate, user.id)
    return getMergedClassesBetweenDatesWithUpcomingGeneration(
        user.id,
        startDate,
        endDate,
        sortedScheduleFrom,
    )
})