.PHONY: build push run deploy

GOOGLE_CLOUD_PROJECT = api-project-466263183174
IMAGE_TAG = gcr.io/$(GOOGLE_CLOUD_PROJECT)/twins-notification

build:
	docker build -t $(IMAGE_TAG) .

push:
	docker push $(IMAGE_TAG)

run:
	docker run --rm --name twins-notification $(IMAGE_TAG)

deploy:
	kubectl apply -f cronjob.yaml
