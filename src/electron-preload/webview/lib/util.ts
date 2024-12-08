import {concatMap, delay, retryWhen} from "rxjs/operators";
import {CookieJar} from "tough-cookie";
import {from, Observable, of, ReplaySubject, throwError} from "rxjs";
import {omit} from "remeda";
import WebStorageCookieStore from "tough-cookie-web-storage-store";

import {asyncDelay, curryFunctionMembers, getPlainErrorProps, isDatabaseBootstrapped} from "src/shared/util";
import {DbPatch} from "src/shared/api/common";
import {depersonalizeProtonApiUrl} from "src/shared/util/proton-url";
import {fillInputValue, getLocationHref} from "src/shared/util/web";
import {FsDbAccount} from "src/shared/model/database";
import {IpcMainApiEndpoints} from "src/shared/api/main-process";
import {LOCAL_WEBCLIENT_ORIGIN, ONE_MINUTE_MS, ONE_SECOND_MS} from "src/shared/const";
import {Logger} from "src/shared/model/common";
import {ProviderApi} from "src/electron-preload/webview/primary/mail/provider-api/model";
import {RATE_LIMITED_METHOD_CALL_MESSAGE} from "src/electron-preload/webview/lib/const";
import {resolveIpcMainApi} from "src/electron-preload/lib/util";
import * as RestModel from "src/electron-preload/webview/lib/rest-model";

export async function submitTotpToken(
    input: HTMLInputElement,
    button: HTMLElement,
    resolveToken: () => Promise<string>,
    _logger: Logger,
    {submitTimeoutMs = ONE_SECOND_MS * 8, newTokenDelayMs = ONE_SECOND_MS * 2, submittingDetection}: {
        submitTimeoutMs?: number;
        newTokenDelayMs?: number;
        submittingDetection?: () => Promise<boolean>;
    } = {},
): Promise<void> {
    const logger = curryFunctionMembers(_logger, nameof(submitTotpToken));

    logger.info();

    if (input.value) {
        throw new Error("2FA TOTP token is not supposed to be pre-filled on this stage");
    }

    const errorMessage = `Failed to submit two factor token within ${submitTimeoutMs}ms`;

    const submit: () => Promise<void> = async () => {
        logger.verbose("submit - start");

        const submitted: () => Promise<boolean> = submittingDetection
            || ((urlBeforeSubmit = getLocationHref()) => {
                return async () => getLocationHref() !== urlBeforeSubmit;
            })();

        fillInputValue(input, await resolveToken());
        logger.verbose("input filled");

        button.click();
        logger.verbose("clicked");

        await asyncDelay(submitTimeoutMs);

        // TODO consider using unified submitting detection
        //      like for example testing that input/button elements no longer attached to DOM or visible
        if (!(await submitted())) {
            throw new Error(errorMessage);
        }

        logger.verbose("submit - success");
    };

    try {
        await submit();
    } catch (error) {
        const {message} = Object(error) as {message?: unknown};

        if (message !== errorMessage) {
            throw error;
        }

        logger.verbose(`submit 1 - fail: ${String(message)}`);
        // second attempt as token might become expired right before submitting
        await asyncDelay(newTokenDelayMs, submit);
    }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function buildDbPatchRetryPipeline<T>(
    preprocessError: (rawError: unknown) => {error: Error; retriable: boolean; skippable: boolean},
    metadata: DeepReadonly<FsDbAccount["metadata"]> | null,
    logger: Logger,
    {retriesDelay = ONE_SECOND_MS * 5, retriesLimit = 3}: {retriesDelay?: number; retriesLimit?: number} = {},
) {
    const errorResult = (error: Error): ReturnType<typeof throwError> => {
        logger.error(nameof(buildDbPatchRetryPipeline), error);
        return throwError(error);
    };

    return retryWhen<T>((errors) =>
        errors.pipe(concatMap((rawError, retryIndex) => {
            const {error, retriable, skippable} = preprocessError(rawError);

            if (!isDatabaseBootstrapped(metadata)) {
                // no retrying for initial/bootstrap fetch
                return errorResult(error);
            }

            if (retryIndex >= retriesLimit) {
                if (skippable) {
                    const message = `Skipping "buildDbPatch" call`;
                    logger.warn(nameof(buildDbPatchRetryPipeline), message, error);
                    return from(Promise.resolve());
                }
                return errorResult(error);
            }

            if (retriable) {
                logger.warn(nameof(buildDbPatchRetryPipeline), `Retrying call (attempt: "${retryIndex}")`);
                return of(error).pipe(delay(retriesDelay));
            }

            return errorResult(error);
        }))
    );
}

export async function persistDatabasePatch(
    providerApi: ProviderApi,
    data: Parameters<IpcMainApiEndpoints["dbPatch"]>[0],
    logger: Logger,
): Promise<void> {
    logger.info(
        `${nameof(persistDatabasePatch)}() start`,
        JSON.stringify({
            metadata: typeof data.metadata === "string"
                ? data.metadata
                : omit(data.metadata, ["latestEventId"]),
        }),
    );

    if (providerApi._throwErrorOnRateLimitedMethodCall) {
        delete providerApi._throwErrorOnRateLimitedMethodCall;
        throw new Error(nameof(providerApi._throwErrorOnRateLimitedMethodCall));
    }

    await resolveIpcMainApi({timeoutMs: ONE_MINUTE_MS * 5, logger})("dbPatch")(data);

    logger.info(`${nameof(persistDatabasePatch)}() end`);
}

export function buildEmptyDbPatch(): DbPatch {
    return {
        conversationEntries: {remove: [], upsert: []},
        mails: {remove: [], upsert: []},
        folders: {remove: [], upsert: []},
        contacts: {remove: [], upsert: []},
    };
}

export function disableBrowserNotificationFeature(parentLogger: Logger): void {
    delete (window as Partial<Pick<typeof window, "Notification">>).Notification;
    parentLogger.info(`browser "notification" feature disabled`);
}

export const fetchEvents = async (
    providerApi: ProviderApi,
    latestEventId: RestModel.Event["EventID"],
    _logger: Logger,
): Promise<{latestEventId: RestModel.Event["EventID"]; events: RestModel.Event[]} | "refresh"> => {
    const logger = curryFunctionMembers(_logger, nameof(fetchEvents));
    const events: RestModel.Event[] = [];
    const iterationState: NoExtraProps<{latestEventId: RestModel.Event["EventID"]; sameNextIdCounter: number}> = {
        latestEventId,
        sameNextIdCounter: 0,
    };

    do {
        const response = await providerApi.events.getEvents(iterationState.latestEventId);
        const hasMoreEvents = response.More === 1;

        if (response.Refresh) {
            // any non-zero value treated as "refresh needed" signal
            return "refresh";
        }

        events.push(response);

        // WARN increase "sameNextIdCounter" before "state.latestEventId" reassigning
        iterationState.sameNextIdCounter += Number(iterationState.latestEventId === response.EventID);
        iterationState.latestEventId = response.EventID;

        if (!hasMoreEvents) {
            break;
        }

        // in early july 2020 protonmail's "/events/{id}" API/backend started returning
        // old/requested "response.EventID" having no more events in the queue ("response.More" !== 1)
        // which looks like an implementation error
        // so let's allow up to 3 such problematic iterations, log the error, and break the iteration then
        // rather than raising the error like we did before in order to detect the protonmail's error
        // it's ok to break the iteration since we start from "latestEventId" next time syncing process gets triggered
        // another error handling approach is to iterate until "response.More" !== 1 but let's prefer "early break" for now
        if (iterationState.sameNextIdCounter > 2) {
            logger.error(`Events API indicates that there is a next event in the queue but responded with the same "next event id".`);
            break;
        }
    } while (true); // eslint-disable-line no-constant-condition

    logger.info(`fetched ${events.length} missed events`);

    return {latestEventId: iterationState.latestEventId, events};
};

type documentCookiesForCustomSchemeType = {
    readonly enable: (logger: Logger) => void;
    readonly setNotification$: Observable<{url: string; cookieString: string}>;
};

// TODO electron: drop custom "document.cookies" logic required for pages loaded via custom scheme/protocol
//      https://github.com/electron/electron/issues/27981
//      https://github.com/ProtonMail/react-components/commit/0558e441583029f644d1a17b68743436a29d5db2#commitcomment-52005249
export const documentCookiesForCustomScheme: documentCookiesForCustomSchemeType = (() => {
    // we don't need all the values but just to be able to send a signal, so "buffer = 1" should be enough
    const setNotificationSubject$ = new ReplaySubject<{url: string; cookieString: string}>(1);
    const result: documentCookiesForCustomSchemeType = {
        setNotification$: setNotificationSubject$.asObservable(),
        enable(logger) {
            logger.verbose(nameof(documentCookiesForCustomScheme), nameof(result.enable));
            const {document} = window;
            const getUrl = (): string => LOCAL_WEBCLIENT_ORIGIN;
            const cookieJar = new CookieJar(new WebStorageCookieStore(window.sessionStorage));

            Object.defineProperty(document, "cookie", {
                enumerable: true,
                configurable: true,
                get(): typeof document.cookie {
                    const url = getUrl();
                    const cookies = cookieJar.getCookiesSync(url);
                    return cookies.map((cookie) => cookie.cookieString()).join("; ");
                },
                set(cookieString: typeof document.cookie) {
                    const url = getUrl();
                    cookieJar.setCookieSync(cookieString, url);
                    setNotificationSubject$.next({url, cookieString});
                },
            });
        },
    };
    return result;
})();

export const isErrorOnRateLimitedMethodCall = (error: unknown): boolean => {
    return (Object(error) as {message?: string}).message === RATE_LIMITED_METHOD_CALL_MESSAGE;
};

export const attachUnhandledErrorHandler = (logger: Logger): void => {
    window.addEventListener("error", (event) => {
        const {message, filename, lineno, colno, error} = event; // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        if (BUILD_ENVIRONMENT === "development") {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            console.log("window.error event:", {message, filename, lineno, colno, error}); // eslint-disable-line no-console
            return;
        }
        // TODO figure the "ResizeObserver loop limit exceeded" error cause (raised by proton)
        const logLevel = (String(filename).startsWith(`${LOCAL_WEBCLIENT_ORIGIN}/`)
                && String(message).startsWith("ResizeObserver loop"))
            ? "warn"
            : "error";
        logger[logLevel](
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            {message, filename: depersonalizeProtonApiUrl(filename), lineno, colno, error: getPlainErrorProps(error)},
        );
        event.preventDefault();
    });
};
