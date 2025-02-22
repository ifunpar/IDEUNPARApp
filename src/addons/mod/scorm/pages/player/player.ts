// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Component, OnInit, OnDestroy } from '@angular/core';
import { CoreMainMenuPage } from '@features/mainmenu/pages/menu/menu';
import { CoreNavigator } from '@services/navigator';
import { CoreSites, CoreSitesReadingStrategy } from '@services/sites';
import { CoreSync } from '@services/sync';
import { CoreDomUtils } from '@services/utils/dom';
import { CoreTimeUtils } from '@services/utils/time';
import { CoreUtils } from '@services/utils/utils';
import { CoreEventObserver, CoreEvents } from '@singletons/events';
import { AddonModScormDataModel12 } from '../../classes/data-model-12';
import { AddonModScormTocComponent } from '../../components/toc/toc';
import {
    AddonModScorm,
    AddonModScormAttemptCountResult,
    AddonModScormGetScormAccessInformationWSResponse,
    AddonModScormProvider,
    AddonModScormScorm,
    AddonModScormScoWithData,
    AddonModScormUserDataMap,
} from '../../services/scorm';
import { AddonModScormHelper, AddonModScormTOCScoWithIcon } from '../../services/scorm-helper';
import { AddonModScormSync } from '../../services/scorm-sync';

/**
 * Page that allows playing a SCORM.
 */
@Component({
    selector: 'page-addon-mod-scorm-player',
    templateUrl: 'player.html',
})
export class AddonModScormPlayerPage implements OnInit, OnDestroy {

    title?: string; // Title.
    scorm!: AddonModScormScorm; // The SCORM object.
    showToc = false; // Whether to show the table of contents (TOC).
    loadingToc = true; // Whether the TOC is being loaded.
    toc: AddonModScormTOCScoWithIcon[] = []; // List of SCOs.
    loaded = false; // Whether the data has been loaded.
    previousSco?: AddonModScormScoWithData; // Previous SCO.
    nextSco?: AddonModScormScoWithData; // Next SCO.
    src?: string; // Iframe src.
    errorMessage?: string; // Error message.
    accessInfo?: AddonModScormGetScormAccessInformationWSResponse; // Access information.
    scormWidth?: number; // Width applied to scorm iframe.
    scormHeight?: number; // Height applied to scorm iframe.
    incomplete = false; // Whether last attempt is incomplete.
    cmId!: number; // Course module ID.
    courseId!: number; // Course ID.

    protected siteId!: string;
    protected mode!: string; // Mode to play the SCORM.
    protected moduleUrl!: string; // Module URL.
    protected newAttempt = false; // Whether to start a new attempt.
    protected organizationId?: string; // Organization ID to load.
    protected attempt?: number; // The attempt number.
    protected offline = false; // Whether it's offline mode.
    protected userData?: AddonModScormUserDataMap; // User data.
    protected initialScoId?: number; // Initial SCO ID to load.
    protected currentSco?: AddonModScormScoWithData; // Current SCO.
    protected dataModel?: AddonModScormDataModel12; // Data Model.
    protected attemptToContinue?: number; // Attempt to continue (for the popover).

    // Observers.
    protected tocObserver?: CoreEventObserver;
    protected launchNextObserver?: CoreEventObserver;
    protected launchPrevObserver?: CoreEventObserver;
    protected goOfflineObserver?: CoreEventObserver;

    constructor(
        protected mainMenuPage: CoreMainMenuPage,
    ) {}

    /**
     * @inheritdoc
     */
    async ngOnInit(): Promise<void> {
        try {
            this.cmId = CoreNavigator.getRequiredRouteNumberParam('cmId');
            this.courseId = CoreNavigator.getRequiredRouteNumberParam('courseId');
            this.mode = CoreNavigator.getRouteParam('mode') || AddonModScormProvider.MODENORMAL;
            this.moduleUrl = CoreNavigator.getRouteParam('moduleUrl') || '';
            this.newAttempt = !!CoreNavigator.getRouteBooleanParam('newAttempt');
            this.organizationId = CoreNavigator.getRouteParam('organizationId');
            this.initialScoId = CoreNavigator.getRouteNumberParam('scoId');
            this.siteId = CoreSites.getCurrentSiteId();
        } catch (error) {
            CoreDomUtils.showErrorModal(error);

            CoreNavigator.back();

            return;
        }

        try {
            // Fetch the SCORM data.
            await this.fetchData();

            if (!this.currentSco) {
                return;
            }

            // Set start time if it's a new attempt.
            if (this.newAttempt) {
                try {
                    await this.setStartTime(this.currentSco.id);
                } catch (error) {
                    CoreDomUtils.instance.showErrorModalDefault(error, 'addon.mod_scorm.errorgetscorm', true);
                }
            }

            // Load SCO.
            this.loadSco(this.currentSco);
        } finally {
            this.loaded = true;
        }

    }

    /**
     * Initialize.
     *
     * @return Promise resolved when done.
     */
    protected async initialize(): Promise<void> {
        // Get the SCORM instance.
        this.scorm = await AddonModScorm.getScorm(this.courseId, this.cmId, {
            moduleUrl: this.moduleUrl,
            readingStrategy: CoreSitesReadingStrategy.PREFER_CACHE,
        });

        // Block the SCORM so it cannot be synchronized.
        CoreSync.blockOperation(AddonModScormProvider.COMPONENT, this.scorm.id, 'player');

        // We use SCORM name at start, later we'll use the SCO title.
        this.title = this.scorm.name;
        this.showToc = AddonModScorm.displayTocInPlayer(this.scorm);

        if (this.scorm.popup) {
            this.mainMenuPage.changeVisibility(false);

            // If we receive a value > 100 we assume it's a fixed pixel size.
            if (this.scorm.width! > 100) {
                this.scormWidth = this.scorm.width;

                // Only get fixed size on height if width is also fixed.
                if (this.scorm.height! > 100) {
                    this.scormHeight = this.scorm.height;
                }
            }
        }

        // Listen for events to update the TOC, navigate through SCOs and go offline.
        this.tocObserver = CoreEvents.on(AddonModScormProvider.UPDATE_TOC_EVENT, (data) => {
            if (data.scormId !== this.scorm.id) {
                return;
            }

            if (this.offline) {
                // Wait a bit to make sure data is stored.
                setTimeout(this.refreshToc.bind(this), 100);
            } else {
                this.refreshToc();
            }
        }, this.siteId);

        this.launchNextObserver = CoreEvents.on(AddonModScormProvider.LAUNCH_NEXT_SCO_EVENT, (data) => {
            if (data.scormId === this.scorm.id && this.nextSco) {
                this.loadSco(this.nextSco);
            }
        }, this.siteId);

        this.launchPrevObserver = CoreEvents.on(AddonModScormProvider.LAUNCH_PREV_SCO_EVENT, (data) => {
            if (data.scormId === this.scorm.id && this.previousSco) {
                this.loadSco(this.previousSco);
            }
        }, this.siteId);

        this.goOfflineObserver = CoreEvents.on(AddonModScormProvider.GO_OFFLINE_EVENT, (data) => {
            if (data.scormId !== this.scorm.id || this.offline) {
                return;
            }
            this.offline = true;

            // Wait a bit to prevent collisions between this store and SCORM API's store.
            setTimeout(async () => {
                try {
                    AddonModScormHelper.convertAttemptToOffline(this.scorm, this.attempt!);
                } catch (error) {
                    CoreDomUtils.instance.showErrorModalDefault(error, 'core.error', true);
                }

                this.refreshToc();
            }, 200);
        }, this.siteId);
    }

    /**
     * Calculate the next and previous SCO.
     *
     * @param scoId Current SCO ID.
     */
    protected calculateNextAndPreviousSco(scoId: number): void {
        this.previousSco = AddonModScormHelper.getPreviousScoFromToc(this.toc, scoId);
        this.nextSco = AddonModScormHelper.getNextScoFromToc(this.toc, scoId);
    }

    /**
     * Determine the attempt to use, the mode (normal/preview) and if it's offline or online.
     *
     * @param attemptsData Attempts count.
     * @return Promise resolved when done.
     */
    protected async determineAttemptAndMode(attemptsData: AddonModScormAttemptCountResult): Promise<void> {
        const data = await AddonModScormHelper.determineAttemptToContinue(this.scorm, attemptsData);

        let incomplete = false;
        this.attempt = data.num;
        this.offline = data.offline;

        if (this.attempt != attemptsData.lastAttempt.num) {
            this.attemptToContinue = this.attempt;
        }

        // Check if current attempt is incomplete.
        if (this.attempt > 0) {
            incomplete = await AddonModScorm.isAttemptIncomplete(this.scorm.id, this.attempt, {
                offline: this.offline,
                cmId: this.cmId,
            });
        }

        // Determine mode and attempt to use.
        const result = AddonModScorm.determineAttemptAndMode(this.scorm, this.mode, this.attempt, this.newAttempt, incomplete);

        if (result.attempt > this.attempt) {
            // We're creating a new attempt.
            if (this.offline) {
                // Last attempt was offline, so we'll create a new offline attempt.
                await AddonModScormHelper.createOfflineAttempt(this.scorm, result.attempt, attemptsData.online.length);
            } else {
                try {
                    // Last attempt was online, verify that we can create a new online attempt. We ignore cache.
                    await AddonModScorm.getScormUserData(this.scorm.id, result.attempt, {
                        cmId: this.cmId,
                        readingStrategy: CoreSitesReadingStrategy.ONLY_NETWORK,
                    });
                } catch {
                    // Cannot communicate with the server, create an offline attempt.
                    this.offline = true;

                    await AddonModScormHelper.createOfflineAttempt(this.scorm, result.attempt, attemptsData.online.length);
                }
            }
        }

        this.mode = result.mode;
        this.newAttempt = result.newAttempt;
        this.attempt = result.attempt;
    }

    /**
     * Fetch data needed to play the SCORM.
     *
     * @return Promise resolved when done.
     */
    protected async fetchData(): Promise<void> {
        if (!this.scorm) {
            await this.initialize();
        }

        // Wait for any ongoing sync to finish. We won't sync a SCORM while it's being played.
        await AddonModScormSync.waitForSync(this.scorm.id);

        try {
            // Get attempts data.
            const attemptsData = await AddonModScorm.getAttemptCount(this.scorm.id, { cmId: this.cmId });

            await this.determineAttemptAndMode(attemptsData);

            const [data, accessInfo] = await Promise.all([
                AddonModScorm.getScormUserData(this.scorm.id, this.attempt!, {
                    cmId: this.cmId,
                    offline: this.offline,
                }),
                AddonModScorm.getAccessInformation(this.scorm.id, {
                    cmId: this.cmId,
                }),
                this.fetchToc(),
            ]);

            this.userData = data;
            this.accessInfo = accessInfo;
        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'addon.mod_scorm.errorgetscorm', true);
        }
    }

    /**
     * Fetch the TOC.
     *
     * @return Promise resolved when done.
     */
    protected async fetchToc(): Promise<void> {
        this.loadingToc = true;

        try {
            // We need to check incomplete again: attempt number or status might have changed.
            this.incomplete = await AddonModScorm.isAttemptIncomplete(this.scorm.id, this.attempt!, {
                offline: this.offline,
                cmId: this.cmId,
            });

            // Get TOC.
            this.toc = await AddonModScormHelper.getToc(this.scorm.id, this.attempt!, this.incomplete, {
                organization: this.organizationId,
                offline: this.offline,
                cmId: this.cmId,
            });

            if (this.currentSco) {
                return;
            }

            if (this.newAttempt) {
                // Creating a new attempt, use the first SCO defined by the SCORM.
                this.initialScoId = this.scorm.launch;
            }

            // Determine current SCO if we received an ID.
            if (this.initialScoId && this.initialScoId > 0) {
                // SCO set by parameter, get it from TOC.
                this.currentSco = AddonModScormHelper.getScoFromToc(this.toc, this.initialScoId);
            }

            if (this.currentSco) {
                return;
            }

            // No SCO defined. Get the first valid one.
            const sco = await AddonModScormHelper.getFirstSco(this.scorm.id, this.attempt!, {
                toc: this.toc,
                organization: this.organizationId,
                mode: this.mode,
                offline: this.offline,
                cmId: this.cmId,
            });

            if (sco) {
                this.currentSco = sco;
            } else {
                // We couldn't find a SCO to load: they're all inactive or without launch URL.
                this.errorMessage = 'addon.mod_scorm.errornovalidsco';
            }
        } finally {
            this.loadingToc = false;
        }
    }

    /**
     * Load a SCO.
     *
     * @param sco The SCO to load.
     * @return Promise resolved when done.
     */
    async loadSco(sco: AddonModScormScoWithData): Promise<void> {
        if (!this.dataModel) {
            // Create the model.
            this.dataModel = new AddonModScormDataModel12(
                this.siteId,
                this.scorm,
                sco.id,
                this.attempt!,
                this.userData!,
                this.mode,
                this.offline,
            );

            // Add the model to the window so the SCORM can access it.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (<any> window).API = this.dataModel;
        } else {
            // Load the SCO in the existing model.
            this.dataModel.loadSco(sco.id);
        }

        this.currentSco = sco;
        this.title = sco.title || this.scorm.name; // Try to use SCO title.

        this.calculateNextAndPreviousSco(sco.id);

        // Load the SCO source.
        this.loadScoSrc(sco);

        if (sco.scormtype == 'asset') {
            // Mark the asset as completed.
            this.markCompleted(sco);
        }

        // Trigger SCO launch event.
        CoreUtils.ignoreErrors(AddonModScorm.logLaunchSco(this.scorm.id, sco.id, this.scorm.name));
    }

    /**
     * Load SCO src.
     *
     * @param sco SCO to load.
     * @return Promise resolved when done.
     */
    protected async loadScoSrc(sco: AddonModScormScoWithData): Promise<void> {
        const src = await AddonModScorm.getScoSrc(this.scorm, sco);

        if (src == this.src) {
            // Re-loading same page. Set it to empty and then re-set the src in the next digest so it detects it has changed.
            this.src = '';

            await CoreUtils.nextTick();
        }

        this.src = src;
    }

    /**
     * Given an SCO, mark it as completed.
     *
     * @param sco SCO to mark.
     * @return Promise resolved when done.
     */
    protected async markCompleted(sco: AddonModScormScoWithData): Promise<void> {
        const tracks = [{
            element: 'cmi.core.lesson_status',
            value: 'completed',
        }];

        try {
            AddonModScorm.saveTracks(sco.id, this.attempt!, tracks, this.scorm, this.offline);
        } catch {
            // Error saving data. Go offline if needed.
            if (this.offline) {
                return;
            }

            const data = await AddonModScorm.getScormUserData(this.scorm.id, this.attempt!, {
                cmId: this.cmId,
            });

            if (data[sco.id] && data[sco.id].userdata['cmi.core.lesson_status'] == 'completed') {
                // Already marked as completed.
                return;
            }

            try {
                // Go offline.
                await AddonModScormHelper.convertAttemptToOffline(this.scorm, this.attempt!);

                this.offline = true;
                this.dataModel?.setOffline(true);

                await AddonModScorm.saveTracks(sco.id, this.attempt!, tracks, this.scorm, true);
            } catch (error) {
                CoreDomUtils.instance.showErrorModalDefault(error, 'core.error', true);
            }
        } finally {
            // Refresh TOC, some prerequisites might have changed.
            this.refreshToc();
        }
    }

    /**
     * Show the TOC.
     */
    async openToc(): Promise<void> {
        const modalData = await CoreDomUtils.openSideModal<AddonModScormScoWithData>({
            component: AddonModScormTocComponent,
            componentProps: {
                toc: this.toc,
                attemptToContinue: this.attemptToContinue,
                selected: this.currentSco && this.currentSco.id,
                moduleId: this.cmId,
                courseId: this.courseId,
                accessInfo: this.accessInfo,
                mode: this.mode,
            },
        });

        if (modalData) {
            this.loadSco(modalData);
        }
    }

    /**
     * Refresh the TOC.
     *
     * @return Promise resolved when done.
     */
    protected async refreshToc(): Promise<void> {
        try {
            await CoreUtils.ignoreErrors(AddonModScorm.invalidateAllScormData(this.scorm.id));

            await this.fetchToc();
        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'addon.mod_scorm.errorgetscorm', true);
        }
    }

    /**
     * Set SCORM start time.
     *
     * @param scoId SCO ID.
     * @return Promise resolved when done.
     */
    protected async setStartTime(scoId: number): Promise<void> {
        const tracks = [{
            element: 'x.start.time',
            value: String(CoreTimeUtils.timestamp()),
        }];

        await AddonModScorm.saveTracks(scoId, this.attempt!, tracks, this.scorm, this.offline);

        if (this.offline) {
            return;
        }

        // New online attempt created, update cached data about online attempts.
        await CoreUtils.ignoreErrors(AddonModScorm.getAttemptCount(this.scorm.id, {
            cmId: this.cmId,
            readingStrategy: CoreSitesReadingStrategy.ONLY_NETWORK,
        }));
    }

    /**
     * @inheritdoc
     */
    ionViewDidEnter(): void {
        if (this.scorm && this.scorm.popup) {
            this.mainMenuPage.changeVisibility(false);
        }
    }

    /**
     * @inheritdoc
     */
    ionViewWillLeave(): void {
        this.mainMenuPage.changeVisibility(true);
    }

    /**
     * Component being destroyed.
     */
    ngOnDestroy(): void {
        // Empty src when leaving the state so unload event is triggered in the iframe.
        this.src = '';
        CoreEvents.trigger(CoreEvents.ACTIVITY_DATA_SENT, { module: 'scorm' });

        // Stop listening for events.
        this.tocObserver?.off();
        this.launchNextObserver?.off();
        this.launchPrevObserver?.off();
        setTimeout(() => {
            this.goOfflineObserver?.off();
        }, 500);

        // Unblock the SCORM so it can be synced.
        CoreSync.unblockOperation(AddonModScormProvider.COMPONENT, this.scorm.id, 'player');
    }

}
